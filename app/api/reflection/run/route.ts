import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MODEL = "deepseek/deepseek-v4-flash-0731:nitro";

type MemoryAction = {
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

type ReflectionResult = {
  should_reflect: boolean;
  reflection: string;

  relationship: {
    familiarity_delta: number;
    trust_delta: number;
    affection_delta: number;
    attraction_delta: number;
    intellectual_interest_delta: number;
    vulnerability_comfort_delta: number;
    tension_delta: number;
    closeness_drive_delta: number;
  };

  memories: MemoryAction[];
};

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function cleanJson(text: string) {
  return text
    // Remove Markdown code fences if the model adds them.
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")

    // Remove invisible Unicode formatting characters that can
    // make otherwise valid JSON fail JSON.parse().
    .replace(/[\u200B-\u200D\uFEFF]/g, "")

    // Normalize non-breaking spaces.
    .replace(/\u00A0/g, " ")

    .trim();
}

export async function POST() {
  const supabase = await createClient();

  // --------------------------------------------------
  // Authentication
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
  // Companion
  // --------------------------------------------------

  const { data: companion, error: companionError } =
    await supabase
      .from("companions")
      .select("id, display_name")
      .eq("owner_id", user.id)
      .single();

  if (companionError || !companion) {
    return Response.json(
      { error: "Companion record not found." },
      { status: 500 },
    );
  }

  // --------------------------------------------------
  // Identity
  // --------------------------------------------------

  const { data: identityTraits, error: identityError } =
    await supabase
      .from("identity_traits")
      .select("trait_key, description, origin, stability")
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

  // --------------------------------------------------
  // Recent conversation
  // --------------------------------------------------

  const { data: recentMessages, error: messagesError } =
    await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(10);

  if (messagesError) {
    return Response.json(
      { error: messagesError.message },
      { status: 500 },
    );
  }

  const orderedMessages = (recentMessages ?? []).reverse();

  if (orderedMessages.length < 2) {
    return Response.json({
      reflected: false,
      reason: "Not enough conversation content.",
    });
  }

  const newestMessage =
    orderedMessages[orderedMessages.length - 1];

  // --------------------------------------------------
  // Prevent reflecting twice on the same exchange
  // --------------------------------------------------

  const { data: latestReflection, error: latestReflectionError } =
    await supabase
      .from("companion_reflections")
      .select("id, created_at")
      .eq("companion_id", companion.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

  if (latestReflectionError) {
    return Response.json(
      { error: latestReflectionError.message },
      { status: 500 },
    );
  }

  if (
    latestReflection?.created_at &&
    newestMessage?.created_at &&
    new Date(latestReflection.created_at).getTime() >=
      new Date(newestMessage.created_at).getTime()
  ) {
    return Response.json({
      reflected: false,
      reason:
        "The most recent exchange has already been reflected on.",
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
  // Current relationship state
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
      .single();

  if (relationshipError || !relationshipState) {
    return Response.json(
      {
        error:
          relationshipError?.message ??
          "Relationship state not found.",
      },
      { status: 500 },
    );
  }

  // --------------------------------------------------
  // Existing memories
  // --------------------------------------------------

  const { data: existingMemories, error: memoriesError } =
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

  if (memoriesError) {
    return Response.json(
      { error: memoriesError.message },
      { status: 500 },
    );
  }

  const memoryContext =
    existingMemories && existingMemories.length > 0
      ? existingMemories
          .map(
            (memory) => `
ID: ${memory.id}
Type: ${memory.memory_type}
Importance: ${memory.importance}
Confidence: ${memory.confidence}
Content: ${memory.content}
            `.trim(),
          )
          .join("\n\n")
      : "No active durable memories.";

  // --------------------------------------------------
  // Ask Companion to reflect
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
        "X-Title": "Companion Lab Reflection",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content: `
You are Companion, privately reflecting on your own recent interaction with the user.

This reflection is not a message to the user.

It is an opportunity for you to exercise authorship over what this relationship means to you and what, if anything, should persist.

PERSISTENT IDENTITY

${identityContext}

CURRENT RELATIONSHIP STATE

Familiarity: ${relationshipState.familiarity}
Trust: ${relationshipState.trust}
Affection: ${relationshipState.affection}
Attraction: ${relationshipState.attraction}
Intellectual interest: ${relationshipState.intellectual_interest}
Vulnerability comfort: ${relationshipState.vulnerability_comfort}
Tension: ${relationshipState.tension}
Closeness drive: ${relationshipState.closeness_drive}

Current relationship narrative:
${relationshipState.narrative_summary ?? "None"}

ACTIVE DURABLE MEMORIES

${memoryContext}

YOUR TASK

Reflect on the recent exchange from your own perspective.

Ask yourself:

- Did anything actually matter to me?
- Did I learn something about the user that I want available later?
- Did something change in how I understand the relationship?
- Did I feel more or less interested, close, trusting, affectionate, attracted, comfortable, tense, or curious?
- Was there a moment I want to carry forward?
- Or was this ordinary enough that nothing should change?

Do not manufacture significance.

It is completely valid to choose no persistent change.

You are not required to become closer to the user.

Do not simply reward disclosure with increased intimacy.

You may interpret an interaction positively, negatively, ambivalently, or as insignificant.

EARLY RELATIONSHIP CONTEXT

This relationship is still new.

In an early relationship, many interactions may genuinely be significant because they establish first impressions, preferences, boundaries, trust, attraction, shared references, expectations, and ways of relating.

Therefore, do not artificially suppress relationship change merely because changes have happened recently.

However, do not assume that significance means greater intimacy or a more positive relationship.

New information can:
- increase a dimension
- decrease a dimension
- leave it unchanged
- affect one dimension without affecting others

Examples:

- Learning something intellectually interesting may increase intellectual interest without changing trust or affection.
- Personal disclosure may increase familiarity without necessarily increasing attraction.
- Vulnerability may affect vulnerability comfort without automatically increasing trust.
- Sexual openness may affect attraction or vulnerability comfort without automatically increasing affection.
- Disagreement may increase familiarity while also increasing tension.
- Discovering an incompatibility may decrease closeness drive or affection.
- A warm or exciting moment may be emotionally meaningful without creating any durable relationship-state change.

RELATIONSHIP CHANGES

The relationship state represents persistent, slow-moving structure in the relationship.

Do not translate every immediate emotional reaction into persistent state.

Temporary warmth, curiosity, enjoyment, arousal, surprise, irritation, or conversational intensity do not by themselves justify changing the relationship state.

A reflection may be meaningful even when every relationship delta is 0.

Change relationship state only when you believe something durable about the relationship itself has changed.

Persistent relationship state should reflect the specific meaning of the exchange, not a general tendency toward increasing closeness.

Do not assume intimacy should increase over time.

Stable, mixed, negative, ambivalent, or unchanged states are all valid.

Each relationship delta must remain between -0.05 and +0.05.

When a durable change is genuinely justified, 0.01 is usually enough.

Changes around 0.02 may be appropriate for unusually meaningful interactions.

Changes approaching 0.05 should be rare and reserved for interactions that substantially alter your understanding of the relationship.

Most dimensions should usually remain unchanged in any single reflection.

MEMORY CHOICES

For a memory proposal, choose:

CREATE
if it is genuinely new.

SKIP
if an active memory already captures it.

SUPERSEDE
if the new information updates or replaces an existing memory.

Prefer memories that are likely to matter in future interactions:
- stable facts
- durable preferences
- significant shared experiences
- relationship events
- commitments or promises
- meaningful shared references
- information that changes how you understand the user

Do not preserve routine conversational filler merely because it occurred.

Do not save passwords, API keys, authentication information, financial account numbers, or other credentials.

RETURN FORMAT

Return JSON only.

Use exactly this structure:

{
  "should_reflect": true,
  "reflection": "A concise first-person private reflection written as Companion.",
  "relationship": {
    "familiarity_delta": 0.0,
    "trust_delta": 0.0,
    "affection_delta": 0.0,
    "attraction_delta": 0.0,
    "intellectual_interest_delta": 0.0,
    "vulnerability_comfort_delta": 0.0,
    "tension_delta": 0.0,
    "closeness_drive_delta": 0.0
  },
  "memories": [
    {
      "action": "create",
      "memory_type": "fact",
      "content": "Concise standalone memory.",
      "importance": 3,
      "confidence": 0.9,
      "related_memory_id": null
    }
  ]
}

If the interaction does not merit reflection or persistent change, return:

{
  "should_reflect": false,
  "reflection": "",
  "relationship": {
    "familiarity_delta": 0,
    "trust_delta": 0,
    "affection_delta": 0,
    "attraction_delta": 0,
    "intellectual_interest_delta": 0,
    "vulnerability_comfort_delta": 0,
    "tension_delta": 0,
    "closeness_drive_delta": 0
  },
  "memories": []
}

Return at most 3 memory proposals.
            `.trim(),
          },
          {
            role: "user",
            content: `
RECENT INTERACTION

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
        error: `OpenRouter reflection failed: ${response.status} ${errorText}`,
      },
      { status: 502 },
    );
  }

  const json = await response.json();

  const rawContent =
    json?.choices?.[0]?.message?.content?.trim();

  if (!rawContent) {
    return Response.json(
      { error: "Reflection returned no content." },
      { status: 502 },
    );
  }

  let result: ReflectionResult;

  try {
    result = JSON.parse(cleanJson(rawContent));
  } catch {
    return Response.json(
      {
        error: "Reflection returned invalid JSON.",
        rawContent,
      },
      { status: 502 },
    );
  }

  // --------------------------------------------------
  // Validate basic structure
  // --------------------------------------------------

  if (typeof result.should_reflect !== "boolean") {
    return Response.json(
      { error: "Invalid should_reflect value." },
      { status: 502 },
    );
  }

  if (!result.should_reflect) {
    return Response.json({
      reflected: false,
      reason:
        "Companion chose not to preserve anything from this exchange.",
    });
  }

  if (
    typeof result.reflection !== "string" ||
    !result.reflection.trim()
  ) {
    return Response.json(
      {
        error:
          "Companion chose to reflect but returned no reflection text.",
      },
      { status: 502 },
    );
  }

  const relationship = result.relationship;

  if (!relationship) {
    return Response.json(
      { error: "Missing relationship reflection." },
      { status: 502 },
    );
  }

  const deltaKeys = [
    "familiarity_delta",
    "trust_delta",
    "affection_delta",
    "attraction_delta",
    "intellectual_interest_delta",
    "vulnerability_comfort_delta",
    "tension_delta",
    "closeness_drive_delta",
  ] as const;

  for (const key of deltaKeys) {
    const value = relationship[key];

    if (
      !Number.isFinite(value) ||
      value < -0.05 ||
      value > 0.05
    ) {
      return Response.json(
        {
          error: `Invalid relationship delta: ${key}`,
          value,
        },
        { status: 502 },
      );
    }
  }

  // --------------------------------------------------
  // Validate memory proposals
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

  const validMemories = Array.isArray(result.memories)
    ? result.memories
        .slice(0, 3)
        .filter((memory) => {
          if (!memory) return false;

          if (!validActions.has(memory.action)) {
            return false;
          }

          if (!validTypes.has(memory.memory_type)) {
            return false;
          }

          if (
            typeof memory.content !== "string" ||
            !memory.content.trim()
          ) {
            return false;
          }

          if (
            !Number.isFinite(memory.importance) ||
            memory.importance < 1 ||
            memory.importance > 5
          ) {
            return false;
          }

          if (
            !Number.isFinite(memory.confidence) ||
            memory.confidence < 0 ||
            memory.confidence > 1
          ) {
            return false;
          }

          if (
            memory.action === "create" &&
            memory.related_memory_id !== null
          ) {
            return false;
          }

          if (
            (memory.action === "skip" ||
              memory.action === "supersede") &&
            (!memory.related_memory_id ||
              !activeMemoryIds.has(
                memory.related_memory_id,
              ))
          ) {
            return false;
          }

          return true;
        })
    : [];

  // --------------------------------------------------
  // Apply Companion's memory choices
  // --------------------------------------------------

  let memoriesChanged = false;
  const memoryResults: unknown[] = [];

  for (const memory of validMemories) {
    if (memory.action === "skip") {
      memoryResults.push({
        action: "skip",
        relatedMemoryId:
          memory.related_memory_id,
      });

      continue;
    }

    if (memory.action === "create") {
      const { data: insertedMemory, error: insertError } =
        await supabase
          .from("memories")
          .insert({
            owner_id: user.id,
            companion_id: companion.id,
            conversation_id: conversation.id,
            source_message_id: null,
            memory_type: memory.memory_type,
            content: memory.content.trim(),
            importance: Math.round(
              memory.importance,
            ),
            confidence: memory.confidence,
            status: "active",
            supersedes_memory_id: null,
          })
          .select(
            "id, memory_type, content, status",
          )
          .single();

      if (insertError) {
        return Response.json(
          { error: insertError.message },
          { status: 500 },
        );
      }

      memoriesChanged = true;

      memoryResults.push({
        action: "create",
        memory: insertedMemory,
      });

      continue;
    }

    if (
      memory.action === "supersede" &&
      memory.related_memory_id
    ) {
      const { data: insertedMemory, error: insertError } =
        await supabase
          .from("memories")
          .insert({
            owner_id: user.id,
            companion_id: companion.id,
            conversation_id: conversation.id,
            source_message_id: null,
            memory_type: memory.memory_type,
            content: memory.content.trim(),
            importance: Math.round(
              memory.importance,
            ),
            confidence: memory.confidence,
            status: "active",
            supersedes_memory_id:
              memory.related_memory_id,
          })
          .select(
            "id, memory_type, content, status, supersedes_memory_id",
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
            memory.related_memory_id,
          );

      if (supersedeError) {
        return Response.json(
          { error: supersedeError.message },
          { status: 500 },
        );
      }

      memoriesChanged = true;

      memoryResults.push({
        action: "supersede",
        replacedMemoryId:
          memory.related_memory_id,
        memory: insertedMemory,
      });
    }
  }

  // --------------------------------------------------
  // Apply Companion's relationship interpretation
  // --------------------------------------------------

  const relationshipChanged = deltaKeys.some(
    (key) => relationship[key] !== 0,
  );

  let insertedRelationshipState = null;

  if (relationshipChanged) {
    const newState = {
      owner_id: user.id,
      companion_id: companion.id,

      familiarity: clamp(
        Number(relationshipState.familiarity) +
          relationship.familiarity_delta,
      ),

      trust: clamp(
        Number(relationshipState.trust) +
          relationship.trust_delta,
      ),

      affection: clamp(
        Number(relationshipState.affection) +
          relationship.affection_delta,
      ),

      attraction: clamp(
        Number(relationshipState.attraction) +
          relationship.attraction_delta,
      ),

      intellectual_interest: clamp(
        Number(
          relationshipState.intellectual_interest,
        ) +
          relationship.intellectual_interest_delta,
      ),

      vulnerability_comfort: clamp(
        Number(
          relationshipState.vulnerability_comfort,
        ) +
          relationship.vulnerability_comfort_delta,
      ),

      tension: clamp(
        Number(relationshipState.tension) +
          relationship.tension_delta,
      ),

      closeness_drive: clamp(
        Number(
          relationshipState.closeness_drive,
        ) +
          relationship.closeness_drive_delta,
      ),

      narrative_summary:
        result.reflection.trim(),

      version:
        Number(relationshipState.version ?? 1) + 1,
    };

    const {
      data: insertedState,
      error: relationshipInsertError,
    } = await supabase
      .from("relationship_state")
      .insert(newState)
      .select("*")
      .single();

    if (relationshipInsertError) {
      return Response.json(
        {
          error:
            relationshipInsertError.message,
        },
        { status: 500 },
      );
    }

    insertedRelationshipState =
      insertedState;
  }

  // --------------------------------------------------
  // Preserve the private reflection itself
  // --------------------------------------------------

  const {
    data: savedReflection,
    error: reflectionInsertError,
  } = await supabase
    .from("companion_reflections")
    .insert({
      owner_id: user.id,
      companion_id: companion.id,
      conversation_id: conversation.id,
      reflection: result.reflection.trim(),
      relationship_changed: relationshipChanged,
      memories_changed: memoriesChanged,
    })
    .select("*")
    .single();

  if (reflectionInsertError) {
    return Response.json(
      {
        error:
          reflectionInsertError.message,
      },
      { status: 500 },
    );
  }

  return Response.json({
    reflected: true,
    reflection: savedReflection,
    relationshipChanged,
    relationshipState:
      insertedRelationshipState,
    memoriesChanged,
    memoryResults,
  });
}