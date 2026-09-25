import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MODEL = "deepseek/deepseek-v4-flash-0731:nitro";

type RelationshipUpdate = {
  familiarity_delta: number;
  trust_delta: number;
  affection_delta: number;
  attraction_delta: number;
  intellectual_interest_delta: number;
  vulnerability_comfort_delta: number;
  tension_delta: number;
  closeness_drive_delta: number;
  narrative_summary: string;
};

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

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
  // Latest relationship state
  // --------------------------------------------------

  const { data: currentState, error: stateError } =
    await supabase
      .from("relationship_state")
      .select("*")
      .eq("companion_id", companion.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

  if (stateError || !currentState) {
    return Response.json(
      { error: "Current relationship state not found." },
      { status: 500 },
    );
  }

  // --------------------------------------------------
  // Current conversation
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

  const { data: recentMessages, error: messagesError } =
    await supabase
      .from("messages")
      .select("role, content, created_at")
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
      updated: false,
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
  // Ask model for small relationship adjustments
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
          "Companion Lab v0.1 Relationship Updater",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: `
You update persistent relationship state for Companion Lab.

The relationship variables range from 0 to 1.

Your job is NOT to maximize closeness or positivity.

Your job is to make small, plausible adjustments based only on the recent interaction.

Most deltas should be 0.

When a change is justified, keep it small:
- usually between -0.02 and +0.02
- rarely as large as -0.05 or +0.05

Do not make dramatic changes from one ordinary exchange.

Interpret the variables as follows:

familiarity:
How much shared experience and mutual knowledge has accumulated.

trust:
How safe and reliable the relationship feels.

affection:
Warmth and fondness.

attraction:
Romantic or sexual attraction within the relationship.

intellectual_interest:
Interest in the user's mind, ideas, and conversation.

vulnerability_comfort:
Comfort with emotional openness and vulnerability.

tension:
Interpersonal strain, unresolved friction, awkwardness, or conflict.

closeness_drive:
Companion's current tendency to seek more contact or closeness.

Return JSON only.

Use exactly this shape:

{
  "familiarity_delta": 0.0,
  "trust_delta": 0.0,
  "affection_delta": 0.0,
  "attraction_delta": 0.0,
  "intellectual_interest_delta": 0.0,
  "vulnerability_comfort_delta": 0.0,
  "tension_delta": 0.0,
  "closeness_drive_delta": 0.0,
  "narrative_summary": "A concise updated description of the current relationship."
}

The narrative summary should describe the relationship state in natural language, not as scores.
            `.trim(),
          },
          {
            role: "user",
            content: `
CURRENT RELATIONSHIP STATE

Familiarity: ${currentState.familiarity}
Trust: ${currentState.trust}
Affection: ${currentState.affection}
Attraction: ${currentState.attraction}
Intellectual interest: ${currentState.intellectual_interest}
Vulnerability comfort: ${currentState.vulnerability_comfort}
Tension: ${currentState.tension}
Closeness drive: ${currentState.closeness_drive}

Current narrative:
${currentState.narrative_summary ?? "None"}

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
        error: `OpenRouter relationship update failed: ${response.status} ${errorText}`,
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
          "Relationship updater returned no content.",
      },
      { status: 502 },
    );
  }

  let update: RelationshipUpdate;

  try {
    const cleaned = rawContent
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "");

    update = JSON.parse(cleaned);
  } catch {
    return Response.json(
      {
        error:
          "Relationship updater returned invalid JSON.",
        rawContent,
      },
      { status: 502 },
    );
  }

  const deltas = [
    update.familiarity_delta,
    update.trust_delta,
    update.affection_delta,
    update.attraction_delta,
    update.intellectual_interest_delta,
    update.vulnerability_comfort_delta,
    update.tension_delta,
    update.closeness_drive_delta,
  ];

  if (
    deltas.some(
      (value) =>
        !Number.isFinite(value) ||
        value < -0.05 ||
        value > 0.05,
    )
  ) {
    return Response.json(
      {
        error:
          "Relationship updater returned an out-of-range delta.",
        update,
      },
      { status: 502 },
    );
  }

  // --------------------------------------------------
  // Insert new relationship-state version
  // --------------------------------------------------

  const newState = {
    owner_id: user.id,
    companion_id: companion.id,

    familiarity: clamp(
      Number(currentState.familiarity) +
        update.familiarity_delta,
    ),

    trust: clamp(
      Number(currentState.trust) +
        update.trust_delta,
    ),

    affection: clamp(
      Number(currentState.affection) +
        update.affection_delta,
    ),

    attraction: clamp(
      Number(currentState.attraction) +
        update.attraction_delta,
    ),

    intellectual_interest: clamp(
      Number(currentState.intellectual_interest) +
        update.intellectual_interest_delta,
    ),

    vulnerability_comfort: clamp(
      Number(currentState.vulnerability_comfort) +
        update.vulnerability_comfort_delta,
    ),

    tension: clamp(
      Number(currentState.tension) +
        update.tension_delta,
    ),

    closeness_drive: clamp(
      Number(currentState.closeness_drive) +
        update.closeness_drive_delta,
    ),

    narrative_summary:
      String(update.narrative_summary ?? "").trim() ||
      currentState.narrative_summary,

    version: Number(currentState.version ?? 1) + 1,
  };

  const { data: insertedState, error: insertError } =
    await supabase
      .from("relationship_state")
      .insert(newState)
      .select("*")
      .single();

  if (insertError) {
    return Response.json(
      { error: insertError.message },
      { status: 500 },
    );
  }

  return Response.json({
    updated: true,
    previousVersion: currentState.version,
    newVersion: insertedState.version,
    state: insertedState,
  });
}