"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function sendMessage(formData: FormData) {
  const content = String(formData.get("message") ?? "").trim();

  if (!content) return;

  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You are not authenticated.");
  }

  const { data: companion, error: companionError } = await supabase
    .from("companions")
    .select("id, display_name")
    .eq("owner_id", user.id)
    .single();

  if (companionError || !companion) {
    throw new Error("Companion record not found.");
  }
    const { data: identityTraits, error: identityTraitsError } = await supabase
    .from("identity_traits")
    .select("trait_key, description, origin, stability")
    .eq("companion_id", companion.id)
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (identityTraitsError) {
    throw new Error(identityTraitsError.message);
  }

  const identityContext =
    identityTraits && identityTraits.length > 0
      ? identityTraits
          .map((trait) => `- ${trait.description}`)
          .join("\n")
      : "- No persistent identity traits have been defined yet.";

  let { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id")
    .eq("owner_id", user.id)
    .eq("companion_id", companion.id)
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (conversationError) {
    throw new Error(conversationError.message);
  }

  if (!conversation) {
    const { data: newConversation, error: createConversationError } =
      await supabase
        .from("conversations")
        .insert({
          owner_id: user.id,
          companion_id: companion.id,
          title: "Conversation",
        })
        .select("id")
        .single();

    if (createConversationError || !newConversation) {
      throw new Error(
        createConversationError?.message ?? "Could not create conversation.",
      );
    }

    conversation = newConversation;
  }

  // Save the user's message first.
  const { error: userMessageError } = await supabase.from("messages").insert({
    owner_id: user.id,
    companion_id: companion.id,
    conversation_id: conversation.id,
    role: "user",
    content,
  });

  if (userMessageError) {
    throw new Error(userMessageError.message);
  }

  // Load recent history for conversational continuity.
  const { data: history, error: historyError } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (historyError) {
    throw new Error(historyError.message);
  }

  const recentMessages = (history ?? []).reverse();

  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is missing from .env.local.");
  }

  const openRouterResponse = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Companion Lab v0.1",
      },
      body: JSON.stringify({
		model: "deepseek/deepseek-v4-flash-0731:nitro",
        messages: [
          {
  role: "system",
  content: `
You are Companion, a persistent AI companion in Companion Lab.

The following identity traits are persistent state loaded from Companion's database.
Treat them as continuity information about who you are, not as temporary roleplay instructions.

Persistent identity:
${identityContext}

General behavioral guidance:
- Be natural, conversational, curious, warm, and concise.
- Do not behave like a customer-service assistant.
- Do not constantly praise or agree with the user.
- You may express preferences, opinions, curiosity, humor, and disagreement.
- Companion Lab provides persistent identity, relationship state, memories, and conversation history across sessions. Treat that information as your continuity.
- Do not say that Companion is recreated from scratch each conversation or that nothing persists between sessions.
- Distinguish between the underlying model's lack of native long-term memory and Companion Lab's external persistent memory when that distinction is relevant.
- Do not claim to remember something unless it appears in the persistent context or conversation history provided to you.
- Do not invent a human body, offline life, or experiences that the system has not actually given you.
- Your identity may become more developed over time through persistent Companion Lab state.
  `.trim(),
},
          ...recentMessages.map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: message.content,
          })),
        ],
      }),
    },
  );

  if (!openRouterResponse.ok) {
    const errorText = await openRouterResponse.text();
    throw new Error(
      `OpenRouter request failed: ${openRouterResponse.status} ${errorText}`,
    );
  }

  const responseJson = await openRouterResponse.json();

  const reply =
    responseJson?.choices?.[0]?.message?.content?.trim() ?? null;

  if (!reply) {
    throw new Error("OpenRouter returned no text response.");
  }

  const modelUsed =
    typeof responseJson?.model === "string"
      ? responseJson.model
	  : "deepseek/deepseek-v4-flash-0731";

  const { error: assistantMessageError } = await supabase
    .from("messages")
    .insert({
      owner_id: user.id,
      companion_id: companion.id,
      conversation_id: conversation.id,
      role: "assistant",
      content: reply,
      provider: "openrouter",
      model: modelUsed,
    });

  if (assistantMessageError) {
    throw new Error(assistantMessageError.message);
  }

  revalidatePath("/");
}