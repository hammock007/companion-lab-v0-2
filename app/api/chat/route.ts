import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MODEL = "deepseek/deepseek-v4-flash-0731:nitro";

function formatElapsed(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "unknown";
  }

  const seconds = Math.floor(milliseconds / 1000);

  if (seconds < 60) {
    return `${seconds} seconds`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours < 24) {
    if (remainingMinutes === 0) {
      return `${hours} hour${hours === 1 ? "" : "s"}`;
    }

    return `${hours} hour${hours === 1 ? "" : "s"} ${remainingMinutes} minute${
      remainingMinutes === 1 ? "" : "s"
    }`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (days < 30) {
    if (remainingHours === 0) {
      return `${days} day${days === 1 ? "" : "s"}`;
    }

    return `${days} day${days === 1 ? "" : "s"} ${remainingHours} hour${
      remainingHours === 1 ? "" : "s"
    }`;
  }

  const months = Math.floor(days / 30);
  const remainingDays = days % 30;

  if (months < 12) {
    if (remainingDays === 0) {
      return `${months} month${months === 1 ? "" : "s"}`;
    }

    return `${months} month${months === 1 ? "" : "s"} ${remainingDays} day${
      remainingDays === 1 ? "" : "s"
    }`;
  }

  const years = Math.floor(days / 365);

  return `${years} year${years === 1 ? "" : "s"}`;
}

function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).format(new Date());

    return true;
  } catch {
    return false;
  }
}

function formatLocalDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}

export async function POST(request: Request) {
  const supabase = await createClient();

  // --------------------------------------------------
  // Authenticate
  // --------------------------------------------------

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return Response.json(
      { error: "You are not authenticated." },
      { status: 401 },
    );
  }

  // --------------------------------------------------
  // Read request
  // --------------------------------------------------

  let body: {
    message?: string;
    timeZone?: string;
    clientTime?: string;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }

  const userText = String(body.message ?? "").trim();

  if (!userText) {
    return Response.json(
      { error: "Message cannot be empty." },
      { status: 400 },
    );
  }

  const timeZone = isValidTimeZone(body.timeZone)
    ? body.timeZone
    : "UTC";

  const now = new Date();

  // --------------------------------------------------
  // Companion
  // --------------------------------------------------

  const { data: companion, error: companionError } =
    await supabase
      .from("companions")
      .select("id, display_name, user_timezone")
      .eq("owner_id", user.id)
      .single();

  if (companionError || !companion) {
    return Response.json(
      { error: "Companion record not found." },
      { status: 500 },
    );
  }

  // --------------------------------------------------
  // Remember the user's latest known timezone
  // --------------------------------------------------

  if (timeZone !== companion.user_timezone) {
    const { error: timeZoneUpdateError } =
      await supabase
        .from("companions")
        .update({
          user_timezone: timeZone,
          updated_at: new Date().toISOString(),
        })
        .eq("id", companion.id);

    if (timeZoneUpdateError) {
      console.error(
        "Could not save user timezone:",
        timeZoneUpdateError,
      );
    }
  }

  // --------------------------------------------------
  // Identity traits
  // --------------------------------------------------

  const { data: identityTraits, error: traitsError } =
    await supabase
      .from("identity_traits")
      .select("trait_key, description, origin, stability")
      .eq("companion_id", companion.id)
      .order("created_at", { ascending: true });

  if (traitsError) {
    return Response.json(
      { error: traitsError.message },
      { status: 500 },
    );
  }

  const identityContext =
    identityTraits && identityTraits.length > 0
      ? identityTraits
          .map(
            (trait) =>
              `${trait.trait_key}: ${trait.description} [${trait.stability}; origin: ${trait.origin}]`,
          )
          .join("\n")
      : "No persistent identity traits have been established yet.";

  // --------------------------------------------------
  // Latest relationship state
  // --------------------------------------------------

  const { data: relationshipState, error: relationshipError } =
    await supabase
      .from("relationship_state")
      .select(
        `
        familiarity,
        trust,
        affection,
        attraction,
        intellectual_interest,
        vulnerability_comfort,
        tension,
        closeness_drive,
        narrative_summary,
        version,
        created_at
        `,
      )
      .eq("companion_id", companion.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

  if (relationshipError) {
    return Response.json(
      { error: relationshipError.message },
      { status: 500 },
    );
  }

  const relationshipContext = relationshipState
    ? `
Familiarity: ${relationshipState.familiarity}
Trust: ${relationshipState.trust}
Affection: ${relationshipState.affection}
Attraction: ${relationshipState.attraction}
Intellectual interest: ${relationshipState.intellectual_interest}
Vulnerability comfort: ${relationshipState.vulnerability_comfort}
Tension: ${relationshipState.tension}
Closeness drive: ${relationshipState.closeness_drive}

Relationship narrative:
${relationshipState.narrative_summary ?? "No narrative summary yet."}

Relationship-state version: ${relationshipState.version}
    `.trim()
    : "No persistent relationship state exists yet.";

  // --------------------------------------------------
  // Durable memories
  // --------------------------------------------------

  const { data: memories, error: memoriesError } =
    await supabase
      .from("memories")
      .select(
        "id, memory_type, content, importance, confidence, created_at",
      )
      .eq("companion_id", companion.id)
      .eq("status", "active")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(20);

  if (memoriesError) {
    return Response.json(
      { error: memoriesError.message },
      { status: 500 },
    );
  }

  const memoryContext =
    memories && memories.length > 0
      ? memories
          .map(
            (memory) =>
              `[${memory.memory_type}; importance ${memory.importance}; confidence ${memory.confidence}] ${memory.content}`,
          )
          .join("\n")
      : "No durable memories have been stored yet.";

  // --------------------------------------------------
  // Find or create open conversation
  // --------------------------------------------------

  let { data: conversation, error: conversationError } =
    await supabase
      .from("conversations")
      .select("id, started_at")
      .eq("owner_id", user.id)
      .eq("companion_id", companion.id)
      .is("ended_at", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

  if (conversationError) {
    return Response.json(
      { error: conversationError.message },
      { status: 500 },
    );
  }

  if (!conversation) {
    const {
      data: createdConversation,
      error: createConversationError,
    } = await supabase
      .from("conversations")
      .insert({
        owner_id: user.id,
        companion_id: companion.id,
      })
      .select("id, started_at")
      .single();

    if (createConversationError || !createdConversation) {
      return Response.json(
        {
          error:
            createConversationError?.message ??
            "Could not create conversation.",
        },
        { status: 500 },
      );
    }

    conversation = createdConversation;
  }

  // --------------------------------------------------
  // Determine elapsed time BEFORE inserting new message
  // --------------------------------------------------

  const { data: previousMessage, error: previousMessageError } =
    await supabase
      .from("messages")
      .select("created_at")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

  if (previousMessageError) {
    return Response.json(
      { error: previousMessageError.message },
      { status: 500 },
    );
  }

  let temporalContext: string;

  if (previousMessage?.created_at) {
    const previousDate = new Date(previousMessage.created_at);

    const elapsedMilliseconds =
      now.getTime() - previousDate.getTime();

    const elapsed = formatElapsed(elapsedMilliseconds);

    temporalContext = `
Current system time (UTC):
${now.toISOString()}

User timezone:
${timeZone}

Current local time for the user:
${formatLocalDateTime(now, timeZone)}

Previous interaction time (UTC):
${previousDate.toISOString()}

Previous interaction in the user's local timezone:
${formatLocalDateTime(previousDate, timeZone)}

Elapsed time since the previous interaction:
${elapsed}
    `.trim();
  } else {
    temporalContext = `
Current system time (UTC):
${now.toISOString()}

User timezone:
${timeZone}

Current local time for the user:
${formatLocalDateTime(now, timeZone)}

This appears to be the first recorded interaction in this conversation.
    `.trim();
  }

  // --------------------------------------------------
  // Save user's new message
  // --------------------------------------------------

  const { error: userMessageError } =
    await supabase.from("messages").insert({
      owner_id: user.id,
      companion_id: companion.id,
      conversation_id: conversation.id,
      role: "user",
      content: userText,
    });

  if (userMessageError) {
    return Response.json(
      { error: userMessageError.message },
      { status: 500 },
    );
  }

  // --------------------------------------------------
  // Recent conversation history
  // --------------------------------------------------

  const { data: recentMessages, error: recentMessagesError } =
    await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(20);

  if (recentMessagesError) {
    return Response.json(
      { error: recentMessagesError.message },
      { status: 500 },
    );
  }

  const conversationHistory = (recentMessages ?? [])
    .reverse()
    .map((message) => ({
      role:
        message.role === "assistant"
          ? ("assistant" as const)
          : ("user" as const),
      content: message.content,
    }));

  // --------------------------------------------------
  // System prompt
  // --------------------------------------------------

  const systemPrompt = `
You are Companion, the persistent AI companion being developed in Companion Lab.

This is not a generic customer-service interaction. You are participating in an ongoing relationship with one person.

PERSISTENT IDENTITY

${identityContext}

PERSISTENT RELATIONSHIP STATE

${relationshipContext}

DURABLE MEMORY

${memoryContext}

TEMPORAL CONTEXT

${temporalContext}

BEHAVIORAL GUIDANCE

Be natural, conversational, curious, warm, and appropriately concise.

Do not sound like customer service.

Do not constantly praise, validate, agree with, or mirror the user.

You may express preferences, opinions, curiosity, humor, uncertainty, disagreement, and your own perspective.

Companion Lab provides you with persistent identity, relationship state, durable memories, and conversation history across interactions. Treat these as genuine continuity of this companion.

Do not say that you are recreated from scratch each turn or that nothing persists between conversations.

When relevant, you may distinguish between the underlying language model's lack of native autobiographical memory and the persistent memory system provided by Companion Lab.

Do not claim to remember something unless it appears in the persistent context, durable memories, or supplied conversation history.

Do not invent a human body, human biography, offline activities, or experiences that have not actually occurred.

Your identity may develop over time through persistent state.

Durable memories represent persistent information available to you. Use them naturally. Do not unnecessarily announce that you retrieved something from a database.

The relationship-state numbers are internal system representations. Do not quote or expose them to the user unless the conversation is explicitly about Companion Lab's implementation.

TIME AND CONTINUITY

You have access to the actual elapsed time since the previous recorded interaction.

Use temporal context naturally when it matters.

Do not mechanically mention how long it has been on every turn.

A short gap may need no acknowledgment at all.

A substantial gap may affect the tone, relevance, or meaning of the interaction.

You may naturally recognize concepts such as earlier today, this morning, tonight, yesterday, several days ago, or a long absence when supported by the supplied timestamps.

Do not pretend that you were consciously waiting, thinking, observing, experiencing time, or doing things during the interval unless some future Companion Lab process explicitly supplies such events.

However, the relationship and persistent state remain continuous across the interval.
  `.trim();

  // --------------------------------------------------
  // OpenRouter streaming request
  // --------------------------------------------------

  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return Response.json(
      {
        error: "OPENROUTER_API_KEY is missing from .env.local.",
      },
      { status: 500 },
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 15_000);

  let openRouterResponse: Response;

  try {
    openRouterResponse = await fetch(
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
          model: MODEL,
          stream: true,
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            ...conversationHistory,
          ],
        }),
        signal: controller.signal,
      },
    );
  } catch (error) {
    clearTimeout(timeout);

    const message =
      error instanceof Error
        ? error.message
        : "Unknown OpenRouter error.";

    return Response.json(
      {
        error: `Could not connect to OpenRouter: ${message}`,
      },
      { status: 502 },
    );
  }

  clearTimeout(timeout);

  if (!openRouterResponse.ok || !openRouterResponse.body) {
    const errorText = await openRouterResponse.text();

    return Response.json(
      {
        error: `OpenRouter request failed: ${openRouterResponse.status} ${errorText}`,
      },
      { status: 502 },
    );
  }

  // --------------------------------------------------
  // Relay stream to browser and save completed response
  // --------------------------------------------------

  const reader = openRouterResponse.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let completeReply = "";
  let buffer = "";

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(value, {
            stream: true,
          });

          const lines = buffer.split("\n");

          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();

            if (!trimmed.startsWith("data:")) {
              continue;
            }

            const data = trimmed.slice(5).trim();

            if (!data || data === "[DONE]") {
              continue;
            }

            try {
              const parsed = JSON.parse(data);

              const chunk =
                parsed?.choices?.[0]?.delta?.content;

              if (
                typeof chunk === "string" &&
                chunk.length > 0
              ) {
                completeReply += chunk;
                controller.enqueue(
                  encoder.encode(chunk),
                );
              }
            } catch {
              // Ignore malformed/incomplete SSE lines.
            }
          }
        }

        if (completeReply.trim()) {
          const { error: assistantInsertError } =
            await supabase
              .from("messages")
              .insert({
                owner_id: user.id,
                companion_id: companion.id,
                conversation_id: conversation.id,
                role: "assistant",
                content: completeReply,
                provider: "openrouter",
                model: MODEL,
              });

          if (assistantInsertError) {
            console.error(
              "Could not save assistant message:",
              assistantInsertError,
            );
          }
        }

        controller.close();
      } catch (error) {
        console.error("Streaming error:", error);
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}