import { createClient } from "@/lib/supabase/server";
import Chat from "./Chat";

export default async function Home() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
        <h1>Companion Lab v0.1</h1>
        <p>You are not signed in.</p>
      </main>
    );
  }

  const { data: companion } = await supabase
    .from("companions")
    .select("id, display_name")
    .eq("owner_id", user.id)
    .single();

  let messages: {
    id: string;
    role: string;
    content: string;
    created_at: string;
  }[] = [];

  if (companion) {
    const { data: conversation } = await supabase
      .from("conversations")
      .select("id")
      .eq("owner_id", user.id)
      .eq("companion_id", companion.id)
      .is("ended_at", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (conversation) {
      const { data } = await supabase
        .from("messages")
        .select("id, role, content, created_at")
        .eq("conversation_id", conversation.id)
        .order("created_at", { ascending: true });

      messages = data ?? [];
    }
  }

  return (
    <main
      style={{
        maxWidth: "800px",
        margin: "0 auto",
        padding: "2rem",
        fontFamily: "sans-serif",
      }}
    >
      <h1>{companion?.display_name ?? "Companion"}</h1>
      <p>Companion Lab v0.1</p>

      <hr style={{ margin: "2rem 0" }} />

      <Chat initialMessages={messages} />
    </main>
  );
}