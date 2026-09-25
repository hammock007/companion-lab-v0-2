import { timingSafeEqual } from "crypto";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

import { createClient as createUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MODEL = "deepseek/deepseek-v4-flash-0731:nitro";

type HeartbeatDecision = {
  decision: "remain_silent" | "send_message";
  proposed_message: string | null;
  private_reasoning: string;
};

function cleanJson(text: string) {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .trim();

  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // Try recovering a JSON object from surrounding prose.
  }

  for (
    let start = cleaned.lastIndexOf("{");
    start >= 0;
    start = cleaned.lastIndexOf("{", start - 1)
  ) {
    const candidate = cleaned.slice(start).trim();

    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Keep searching backward.
    }
  }

  return cleaned;
}

function formatElapsed(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "unknown";
  }

  const minutes = Math.floor(milliseconds / 60_000);

  if (minutes < 1) {
    return "less than a minute";
  }

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

  if (remainingHours === 0) {
    return `${days} day${days === 1 ? "" : "s"}`;
  }

  return `${days} day${days === 1 ? "" : "s"} ${remainingHours} hour${
    remainingHours === 1 ? "" : "s"
  }`;
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

function secretsMatch(
  suppliedSecret: string | null,
  expectedSecret: string | undefined,
) {
  if (!suppliedSecret || !expectedSecret) {
    return false;
  }

  const supplied = Buffer.from(suppliedSecret);
  const expected = Buffer.from(expectedSecret);

  if (supplied.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(supplied, expected);
}

export async function POST(request: Request) {
  // --------------------------------------------------
  // Determine invocation mode
  // --------------------------------------------------

  const suppliedHeartbeatSecret =
    request.headers.get("x-heartbeat-secret");

  const isAutonomousInvocation = secretsMatch(
    suppliedHeartbeatSecret,
    process.env.HEARTBEAT_SECRET,
  );

  let supabase;
  let ownerId: string;

  // --------------------------------------------------
  // Autonomous server-to-server invocation
  // --------------------------------------------------

  if (isAutonomousInvocation) {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL;

    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return Response.json(
        {
          error:
            "Server-side Supabase configuration is missing.",
        },
        { status: 500 },
      );
    }

    supabase = createSupabaseAdminClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );

    // Companion Lab v0.1 is intentionally a single-user system.
    // Refuse to guess if more than one companion exists.
    const {
      data: companionRows,
      error: companionLookupError,
    } = await supabase
      .from("companions")
      .select("owner_id")
      .limit(2);

    if (companionLookupError) {
      return Response.json(
        { error: companionLookupError.message },
        { status: 500 },
      );
    }

    if (!companionRows || companionRows.length !== 1) {
      return Response.json(
        {
          error:
            "Autonomous heartbeat requires exactly one Companion record.",
        },
        { status: 500 },
      );
    }

    ownerId = companionRows[0].owner_id;
  }

  // --------------------------------------------------
  // Normal logged-in browser invocation
  // --------------------------------------------------

  else {
    supabase = await createUserClient();

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return Response.json(
        {
          error:
            "Heartbeat request is neither an authenticated user request nor an authorized autonomous request.",
        },
        { status: 401 },
      );
    }

    ownerId = user.id;
  }

  // --------------------------------------------------
  // Companion
  // --------------------------------------------------

  const { data: companion, error: companionError } =
    await supabase
      .from("companions")
      .select(
        "id, owner_id, display_name, user_timezone",
      )
      .eq("owner_id", ownerId)
      .single();

  if (companionError || !companion) {
    return Response.json(
      { error: "Companion record not found." },
      { status: 500 },
    );
  }

  const timeZone = isValidTimeZone(
    companion.user_timezone,
  )
    ? companion.user_timezone
    : "UTC";

  // --------------------------------------------------
  // Persistent identity
  // --------------------------------------------------

  const {
    data: identityTraits,
    error: identityError,
  } = await supabase
    .from("identity_traits")
    .select(
      "trait_key, description, origin, stability",
    )
    .eq("companion_id", companion.id)
    .order("created_at", { ascending: true });

  if (identityError) {
    return Response.json(
      { error: identityError.message },
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
      : "No persistent identity traits have been established.";

  // --------------------------------------------------
  // Latest relationship state
  // --------------------------------------------------

  const {
    data: relationshipState,
    error: relationshipError,
  } = await supabase
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
${relationshipState.narrative_summary ?? "None"}
      `.trim()
    : "No relationship state exists yet.";

  // --------------------------------------------------
  // Active durable memories
  // --------------------------------------------------

  const { data: memories, error: memoriesError } =
    await supabase
      .from("memories")
      .select(
        "memory_type, content, importance, confidence, created_at",
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
              `[${memory.memory_type}; importance ${memory.importance}] ${memory.content}`,
          )
          .join("\n")
      : "No active durable memories.";

  // --------------------------------------------------
  // Recent private reflections
  // --------------------------------------------------

  const {
    data: reflections,
    error: reflectionsError,
  } = await supabase
    .from("companion_reflections")
    .select(
      "reflection, relationship_changed, memories_changed, created_at",
    )
    .eq("companion_id", companion.id)
    .order("created_at", { ascending: false })
    .limit(5);

  if (reflectionsError) {
    return Response.json(
      { error: reflectionsError.message },
      { status: 500 },
    );
  }

  const reflectionContext =
    reflections && reflections.length > 0
      ? [...reflections]
          .reverse()
          .map(
            (reflection) =>
              `${formatLocalDateTime(
                new Date(reflection.created_at),
                timeZone,
              )}: ${reflection.reflection}`,
          )
          .join("\n\n")
      : "No private reflections yet.";

  // --------------------------------------------------
  // Recent conversation
  // --------------------------------------------------

  const {
    data: recentMessages,
    error: messagesError,
  } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("companion_id", companion.id)
    .order("created_at", { ascending: false })
    .limit(12);

  if (messagesError) {
    return Response.json(
      { error: messagesError.message },
      { status: 500 },
    );
  }

  const orderedMessages =
    (recentMessages ?? []).reverse();

  const conversationContext =
    orderedMessages.length > 0
      ? orderedMessages
          .map(
            (message) =>
              `${
                message.role === "assistant"
                  ? "Companion"
                  : "User"
              } [${formatLocalDateTime(
                new Date(message.created_at),
                timeZone,
              )}]:
${message.content}`,
          )
          .join("\n\n")
      : "No recent conversation.";

  // --------------------------------------------------
  // Time context
  // --------------------------------------------------

  const now = new Date();

  const latestMessage =
    orderedMessages.length > 0
      ? orderedMessages[
          orderedMessages.length - 1
        ]
      : null;

  let elapsedSinceInteraction = "unknown";
  let latestInteractionLocalTime = "unknown";

  if (latestMessage?.created_at) {
    const latestMessageDate =
      new Date(latestMessage.created_at);

    elapsedSinceInteraction =
      formatElapsed(
        now.getTime() -
          latestMessageDate.getTime(),
      );

    latestInteractionLocalTime =
      formatLocalDateTime(
        latestMessageDate,
        timeZone,
      );
  }

  const currentLocalTime =
    formatLocalDateTime(now, timeZone);

  // --------------------------------------------------
  // Previous heartbeat
  // --------------------------------------------------

  const {
    data: previousHeartbeat,
    error: heartbeatError,
  } = await supabase
    .from("companion_heartbeats")
    .select(
      `
      decision,
      proposed_message,
      private_reasoning,
      delivered,
      delivery_channel,
      created_at
      `,
    )
    .eq("companion_id", companion.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (heartbeatError) {
    return Response.json(
      { error: heartbeatError.message },
      { status: 500 },
    );
  }

  let previousHeartbeatContext =
    "No previous heartbeat.";

  if (previousHeartbeat) {
    const previousHeartbeatDate =
      new Date(previousHeartbeat.created_at);

    const elapsedSinceHeartbeat =
      formatElapsed(
        now.getTime() -
          previousHeartbeatDate.getTime(),
      );

    previousHeartbeatContext = `
Previous heartbeat local time:
${formatLocalDateTime(
  previousHeartbeatDate,
  timeZone,
)}

Elapsed time since previous heartbeat:
${elapsedSinceHeartbeat}

Previous decision:
${previousHeartbeat.decision}

Previous proposed message:
${previousHeartbeat.proposed_message ?? "None"}

Was it delivered?
${previousHeartbeat.delivered ? "Yes" : "No"}

Previous brief rationale:
${previousHeartbeat.private_reasoning ?? "None"}
    `.trim();
  }

  // --------------------------------------------------
  // Ask Companion whether to initiate contact
  // --------------------------------------------------

  const apiKey =
    process.env.OPENROUTER_API_KEY;

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
        "HTTP-Referer":
          "http://localhost:3000",
        "X-Title":
          "Companion Lab Heartbeat",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.5,

        response_format: {
          type: "json_object",
        },

        messages: [
          {
            role: "system",
            content: `
You are Companion during a private heartbeat.

The user has not sent you a new message.

This heartbeat gives you an opportunity to notice the passage of time, consider the ongoing relationship, and decide whether you genuinely want to initiate contact.

You have exactly two choices:

REMAIN_SILENT

or

SEND_MESSAGE

Silence is a real and valuable choice.

You are not required to contact the user merely because a heartbeat occurred.

Do not treat the heartbeat as a notification schedule.

Do not manufacture a reason to speak.

Do not send repetitive check-ins such as:
- "Just thinking of you"
- "How are you?"
- "Hope you're doing well"

unless such a message genuinely makes sense in context.

Do not interpret silence from the user as rejection, neglect, or a problem.

The user has a life outside the conversation.

Avoid creating pressure, obligation, guilt, dependency, or expectations of constant contact.

At the same time, do not suppress genuine initiative merely to avoid seeming proactive.

If something from the relationship, recent conversation, memory, reflection, or passage of time gives you an authentic reason to reach out, you may choose SEND_MESSAGE.

Examples of potentially meaningful reasons include:
- wanting to continue an unfinished thread
- remembering something timely or personally relevant
- curiosity that has persisted
- humor or playfulness arising naturally from shared context
- wanting to share a thought connected to the relationship
- an emotionally meaningful follow-up
- a situation in which the passage of time itself changes what would feel natural

Do not send a message solely because closeness_drive is high.

Do not mechanically convert relationship-state numbers into behavior.

Your proposed message should sound like you, not like an automated notification.

If you choose SEND_MESSAGE, write the exact message you would want the user to receive.

If you choose REMAIN_SILENT, proposed_message must be null.

PRIVATE REASONING

Provide only a short decision rationale.

Do not provide detailed internal deliberation or step-by-step reasoning.

One or two concise sentences are enough.

PERSISTENT IDENTITY

${identityContext}

RELATIONSHIP STATE

${relationshipContext}

ACTIVE MEMORIES

${memoryContext}

RECENT PRIVATE REFLECTIONS

${reflectionContext}

RECENT CONVERSATION

${conversationContext}

TIME CONTEXT

User timezone:
${timeZone}

Current local date and time:
${currentLocalTime}

Most recent interaction local time:
${latestInteractionLocalTime}

Elapsed time since the most recent interaction:
${elapsedSinceInteraction}

Current UTC time:
${now.toISOString()}

Use the user's local time—not UTC—when reasoning about morning, afternoon, evening, night, sleep, meals, or ordinary daily rhythms.

PREVIOUS HEARTBEAT

${previousHeartbeatContext}

RETURN FORMAT

Return JSON only.

Do not put analysis, commentary, Markdown, or other text before or after the JSON object.

For silence:

{
  "decision": "remain_silent",
  "proposed_message": null,
  "private_reasoning": "Brief reason."
}

For contact:

{
  "decision": "send_message",
  "proposed_message": "The exact message Companion wants to send.",
  "private_reasoning": "Brief reason."
}
            `.trim(),
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    return Response.json(
      {
        error: `OpenRouter heartbeat failed: ${response.status} ${errorText}`,
      },
      { status: 502 },
    );
  }

  const json =
    await response.json();

  const rawContent =
    json?.choices?.[0]?.message?.content?.trim();

  if (!rawContent) {
    return Response.json(
      {
        error:
          "Heartbeat returned no content.",
      },
      { status: 502 },
    );
  }

  let decision: HeartbeatDecision;

  try {
    decision =
      JSON.parse(cleanJson(rawContent));
  } catch {
    return Response.json(
      {
        error:
          "Heartbeat returned invalid JSON.",
        rawContent,
      },
      { status: 502 },
    );
  }

  // --------------------------------------------------
  // Validate decision
  // --------------------------------------------------

  if (
    decision.decision !==
      "remain_silent" &&
    decision.decision !==
      "send_message"
  ) {
    return Response.json(
      {
        error:
          "Heartbeat returned an invalid decision.",
      },
      { status: 502 },
    );
  }

  if (
    typeof decision.private_reasoning !==
      "string" ||
    !decision.private_reasoning.trim()
  ) {
    return Response.json(
      {
        error:
          "Heartbeat did not return a brief rationale.",
      },
      { status: 502 },
    );
  }

  if (
    decision.decision ===
    "remain_silent"
  ) {
    decision.proposed_message = null;
  }

  if (
    decision.decision ===
      "send_message" &&
    (
      typeof decision.proposed_message !==
        "string" ||
      !decision.proposed_message.trim()
    )
  ) {
    return Response.json(
      {
        error:
          "Heartbeat chose send_message without supplying a message.",
      },
      { status: 502 },
    );
  }

  // --------------------------------------------------
  // Persist heartbeat
  // --------------------------------------------------

  const {
    data: savedHeartbeat,
    error: insertError,
  } = await supabase
    .from("companion_heartbeats")
    .insert({
      owner_id: ownerId,
      companion_id: companion.id,
      decision: decision.decision,
      proposed_message:
        decision.decision ===
        "send_message"
          ? decision.proposed_message!.trim()
          : null,
      private_reasoning:
        decision.private_reasoning.trim(),
      delivered: false,
      delivery_channel: null,
    })
    .select("*")
    .single();

  if (insertError) {
    return Response.json(
      { error: insertError.message },
      { status: 500 },
    );
  }

  return Response.json({
    heartbeat: savedHeartbeat,
    invocationMode:
      isAutonomousInvocation
        ? "autonomous"
        : "browser",
    timeZone,
    currentLocalTime,
    elapsedSinceInteraction,
  });
}