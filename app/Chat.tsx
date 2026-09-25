"use client";

import { FormEvent, useState } from "react";

type Message = {
  id: string;
  role: string;
  content: string;
  created_at: string;
};

type ChatProps = {
  initialMessages: Message[];
};

export default function Chat({ initialMessages }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = input.trim();

    if (!trimmed || isSending) {
      return;
    }

    const userMessage: Message = {
      id: `local-user-${Date.now()}`,
      role: "user",
      content: trimmed,
      created_at: new Date().toISOString(),
    };

    const assistantMessage: Message = {
      id: `local-assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      created_at: new Date().toISOString(),
    };

    setMessages((current) => [
      ...current,
      userMessage,
      assistantMessage,
    ]);

    setInput("");
    setIsSending(true);

    try {
      const timeZone =
        Intl.DateTimeFormat().resolvedOptions().timeZone;

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: trimmed,
          timeZone,
          clientTime: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);

        throw new Error(
          errorBody?.error ??
            `Request failed with status ${response.status}`,
        );
      }

      if (!response.body) {
        throw new Error("Streaming response body was missing.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });

        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  content: message.content + chunk,
                }
              : message,
          ),
        );
      }

      // After the visible reply completes, give Companion a private
      // opportunity to decide what, if anything, should persist.
      fetch("/api/reflection/run", {
        method: "POST",
      })
        .then(async (reflectionResponse) => {
          if (!reflectionResponse.ok) {
            const text = await reflectionResponse.text();

            console.error(
              "Companion reflection failed:",
              reflectionResponse.status,
              text,
            );

            return;
          }

          const result = await reflectionResponse.json();

          console.log("Companion reflection:", result);
        })
        .catch((error) => {
          console.error(
            "Companion reflection failed:",
            error,
          );
        });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown error while contacting Companion.";

      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessage.id
            ? {
                ...item,
                content: `[Error: ${message}]`,
              }
            : item,
        ),
      );
    } finally {
      setIsSending(false);
    }
  }

  return (
    <>
      <section style={{ minHeight: "300px" }}>
        {messages.length === 0 ? (
          <p>No messages yet.</p>
        ) : (
          messages.map((message) => {
            const isUser = message.role === "user";

            return (
              <div
                key={message.id}
                style={{
                  display: "flex",
                  justifyContent: isUser ? "flex-end" : "flex-start",
                  marginBottom: "1.4rem",
                }}
              >
                {!isUser && (
                  <img
                    src="/companion-avatar.jpg"
                    alt="Companion"
                    style={{
                      width: "120px",
                      height: "120px",
                      borderRadius: "10px",
                      objectFit: "cover",
                      objectPosition: "center",
                      marginRight: "0.9rem",
                      flexShrink: 0,
                    }}
                  />
                )}

                <div
                  style={{
                    maxWidth: "75%",
                    padding: "0.9rem 1rem",
                    borderRadius: "14px",
                    backgroundColor: isUser
                      ? "#f3f4f6"
                      : "#dbeafe",
                    color: "#1f2937",
                  }}
                >
                  <strong
                    style={{
                      display: "block",
                      marginBottom: "0.25rem",
                    }}
                  >
                    {isUser ? "You" : "Companion"}
                  </strong>

                  <div
                    style={{
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {message.content ||
                      (!isUser
                        ? "Companion is thinking..."
                        : "")}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </section>

      <form onSubmit={handleSubmit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={isSending}
          rows={4}
          placeholder="Write a message..."
          style={{
            width: "100%",
            padding: "0.75rem",
            fontSize: "1rem",
            marginBottom: "0.75rem",
          }}
        />

        <button
          type="submit"
          disabled={isSending || !input.trim()}
          style={{
            padding: "0.75rem 1.25rem",
            fontSize: "1rem",
            cursor:
              isSending || !input.trim()
                ? "not-allowed"
                : "pointer",
          }}
        >
          {isSending ? "Sending..." : "Send"}
        </button>
      </form>
    </>
  );
}