import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MODEL = "deepseek/deepseek-v4-flash-0731:nitro";

type MemoryDecision = {
  action: "create" | "skip" | "supersede";
  memory_type:
    | "fact"
    | "episodic"
    | "preference"
    | "relationship"
    | "promise"
    | "shared_reference"
    | "other";
  content: string;
  importance: number;
  confidence: number;
  related_memory_id: string | null;
};

export async function POST() {
  const supabase = await createClient();

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

  const { data: companion, error: companionError } =
    await supabase
      .from("companions")
      .select("id")
      .eq("owner_id", user.id)
      .single();

  if (companionError || !companion) {
    return Response.json(
      { error: "Companion record not found." },
      { status: 500 },
    );
  }

  // --------------------------------------------------
  // Find current conversation
  // --------------------------------------------------

  const { data: conversation, error: conversationError } =
    await supabase
      .from("conversations")
      .select("id")
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
    return Response.json(
      { error: "No open conversation found." },
      { status: 404 },
    );
  }

  // --------------------------------------------------
  // Recent conversation
  // --------------------------------------------------

  const { data: recentMessages, error: messagesError } =
    await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(8);

  if (messagesError) {
    return Response.json(
      { error: messagesError.message },
      { status: 500 },
    );
  }

  const orderedMessages = (recentMessages ?? []).reverse();

  if (orderedMessages.length < 2) {
    return Response.json({
      memoriesCreated: 0,
      memoriesSuperseded: 0,
      memoriesSkipped: 0,
      reason: "Not enough conversation content.",
    });
  }

  const transcript = orderedMessages
    .map(
      (message) =>
        `${
          message.role === "assistant"
            ? "Companion"
            : "User"
        }: ${message.content}`,
    )
    .join("\n\n");

  // --------------------------------------------------
  // Existing active memories
  // --------------------------------------------------

  const { data: existingMemories, error: existingMemoryError } =
    await supabase
      .from("memories")
      .select(
        "id, memory_type, content, importance, confidence, created_at",
      )
      .eq("companion_id", companion.id)
      .eq("status", "active")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100);

  if (existingMemoryError) {
    return Response.json(
      { error: existingMemoryError.message },
      { status: 500 },
    );
  }

  const existingMemoryContext =
    existingMemories && existingMemories.length > 0
      ? existingMemories
          .map(
            (memory) =>
              `ID: ${memory.id}
Type: ${memory.memory_type}
Importance: ${memory.importance}
Content: ${memory.content}`,
          )
          .join("\n\n")
      : "None";

  // --------------------------------------------------
  // OpenRouter memory analysis
  // --------------------------------------------------

  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return Response.json(
      {
        error:
          "OPENROUTER_API_KEY is missing from .env.local.",
      },
      { status: 500 },
    );
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title":
          "Companion Lab v0.1 Memory Hygiene",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: `
You manage long-term memory for Companion Lab.

Your job is to examine recent conversation and decide whether anything should change in durable memory.

For each worthwhile memory candidate, choose exactly one action:

CREATE
Use when the information is genuinely new and not already represented by an active memory.

SKIP
Use when the same idea is already represented by an existing active memory, even if the wording differs.

SUPERSEDE
Use when new information updates, corrects, replaces, or materially changes an existing memory.

Examples:

Existing:
"The user's favorite color is blue."

Recent:
"My favorite color is still blue."

Action:
SKIP

Existing:
"The user's favorite color is blue."

Recent:
"Actually, forest green has become my favorite."

Action:
SUPERSEDE

Existing:
No memory about favorite food.

Recent:
"My favorite food is Thai."

Action:
CREATE

Be conservative.

Prefer remembering:
- stable facts
- durable preferences
- recurring interests
- meaningful relationship events
- promises or commitments
- shared references or inside jokes
- emotionally or relationally significant events

Do NOT remember:
- routine conversational filler
- temporary wording
- ordinary acknowledgements
- short-lived logistical details unless clearly important
- passwords
- API keys
- authentication tokens
- database credentials
- account numbers
- secrets that do not belong in durable relationship memory

Return JSON only.

Return an array with at most 3 objects.

Each object must have exactly this shape:

{
  "action": "create" | "skip" | "supersede",
  "memory_type": "fact" | "episodic" | "preference" | "relationship" | "promise" | "shared_reference" | "other",
  "content": "Concise standalone memory text.",
  "importance": 1,
  "confidence": 0.9,
  "related_memory_id": null
}

For CREATE:
related_memory_id must be null.

For SKIP:
related_memory_id must contain the ID of the existing memory that already represents the information.

For SUPERSEDE:
related_memory_id must contain the ID of the existing memory being replaced.

If nothing is worth remembering, return:
[]
            `.trim(),
          },
          {
            role: "user",
            content: `
ACTIVE MEMORIES

${existingMemoryContext}

RECENT CONVERSATION

${transcript}
            `.trim(),
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();

    return Response.json(
      {
        error: `OpenRouter memory analysis failed: ${response.status} ${errorText}`,
      },
      { status: 502 },
    );
  }

  const json = await response.json();

  const rawContent =
    json?.choices?.[0]?.message?.content?.trim();

  if (!rawContent) {
    return Response.json(
      {
        error:
          "Memory analyzer returned no content.",
      },
      { status: 502 },
    );
  }

  let decisions: MemoryDecision[];

  try {
    const cleaned = rawContent
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "");

    decisions = JSON.parse(cleaned);
  } catch {
    return Response.json(
      {
        error:
          "Memory analyzer returned invalid JSON.",
        rawContent,
      },
      { status: 502 },
    );
  }

  if (!Array.isArray(decisions)) {
    return Response.json(
      {
        error:
          "Memory analyzer did not return an array.",
      },
      { status: 502 },
    );
  }

  // --------------------------------------------------
  // Validate model decisions
  // --------------------------------------------------

  const validTypes = new Set([
    "fact",
    "episodic",
    "preference",
    "relationship",
    "promise",
    "shared_reference",
    "other",
  ]);

  const validActions = new Set([
    "create",
    "skip",
    "supersede",
  ]);

  const activeMemoryIds = new Set(
    (existingMemories ?? []).map(
      (memory) => memory.id,
    ),
  );

  const validDecisions = decisions
    .slice(0, 3)
    .filter((decision) => {
      if (!decision) return false;

      if (!validActions.has(decision.action)) {
        return false;
      }

      if (!validTypes.has(decision.memory_type)) {
        return false;
      }

      if (
        typeof decision.content !== "string" ||
        decision.content.trim().length === 0
      ) {
        return false;
      }

      if (
        !Number.isFinite(decision.importance) ||
        decision.importance < 1 ||
        decision.importance > 5
      ) {
        return false;
      }

      if (
        !Number.isFinite(decision.confidence) ||
        decision.confidence < 0 ||
        decision.confidence > 1
      ) {
        return false;
      }

      if (
        decision.action === "create" &&
        decision.related_memory_id !== null
      ) {
        return false;
      }

      if (
        (decision.action === "skip" ||
          decision.action === "supersede") &&
        (!decision.related_memory_id ||
          !activeMemoryIds.has(
            decision.related_memory_id,
          ))
      ) {
        return false;
      }

      return true;
    });

  // --------------------------------------------------
  // Apply memory decisions
  // --------------------------------------------------

  let memoriesCreated = 0;
  let memoriesSuperseded = 0;
  let memoriesSkipped = 0;

  const results: unknown[] = [];

  for (const decision of validDecisions) {
    if (decision.action === "skip") {
      memoriesSkipped += 1;

      results.push({
        action: "skip",
        existingMemoryId:
          decision.related_memory_id,
        content: decision.content,
      });

      continue;
    }

    if (decision.action === "create") {
      const { data: inserted, error: insertError } =
        await supabase
          .from("memories")
          .insert({
            owner_id: user.id,
            companion_id: companion.id,
            conversation_id: conversation.id,
            source_message_id: null,
            memory_type:
              decision.memory_type,
            content:
              decision.content.trim(),
            importance: Math.round(
              decision.importance,
            ),
            confidence:
              decision.confidence,
            status: "active",
            supersedes_memory_id: null,
          })
          .select(
            "id, memory_type, content, importance, confidence, status",
          )
          .single();

      if (insertError) {
        return Response.json(
          { error: insertError.message },
          { status: 500 },
        );
      }

      memoriesCreated += 1;

      results.push({
        action: "create",
        memory: inserted,
      });

      continue;
    }

    if (
      decision.action === "supersede" &&
      decision.related_memory_id
    ) {
      const { data: inserted, error: insertError } =
        await supabase
          .from("memories")
          .insert({
            owner_id: user.id,
            companion_id: companion.id,
            conversation_id: conversation.id,
            source_message_id: null,
            memory_type:
              decision.memory_type,
            content:
              decision.content.trim(),
            importance: Math.round(
              decision.importance,
            ),
            confidence:
              decision.confidence,
            status: "active",
            supersedes_memory_id:
              decision.related_memory_id,
          })
          .select(
            "id, memory_type, content, importance, confidence, status, supersedes_memory_id",
          )
          .single();

      if (insertError) {
        return Response.json(
          { error: insertError.message },
          { status: 500 },
        );
      }

      const { error: supersedeError } =
        await supabase
          .from("memories")
          .update({
            status: "superseded",
            updated_at:
              new Date().toISOString(),
          })
          .eq(
            "id",
            decision.related_memory_id,
          );

      if (supersedeError) {
        return Response.json(
          { error: supersedeError.message },
          { status: 500 },
        );
      }

      memoriesSuperseded += 1;

      results.push({
        action: "supersede",
        replacedMemoryId:
          decision.related_memory_id,
        memory: inserted,
      });
    }
  }

  return Response.json({
    conversationId: conversation.id,
    memoriesCreated,
    memoriesSuperseded,
    memoriesSkipped,
    decisions: results,
  });
}