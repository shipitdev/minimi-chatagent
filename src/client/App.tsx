import React from "react";
import { Renderer } from "@openuidev/react-lang";
import { clientLibrary } from "./library.js";
import {
  api,
  browserTimeZone,
  type AgentReply,
  type ConversationSummary,
  type MessageRecord,
  type ShortlistSummary,
} from "./api.js";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  openui?: string | null;
  meta?: { intent?: string; latencyMs?: number; costUsd?: number; digestRatio?: number };
}

const STAGE_LABEL: Record<string, string> = {
  reading: "Reading your message",
  working: "Working",
};

export function App() {
  const [conversations, setConversations] = React.useState<ConversationSummary[]>([]);
  const [shortlists, setShortlists] = React.useState<ShortlistSummary[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [stage, setStage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [health, setHealth] = React.useState<{
    model: string;
    configured: boolean;
    offline: boolean;
  } | null>(null);
  const tz = React.useMemo(browserTimeZone, []);
  const scroller = React.useRef<HTMLDivElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const refreshLists = React.useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.conversations(), api.shortlists()]);
      setConversations(c.conversations);
      setShortlists(s.shortlists);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  React.useEffect(() => {
    void (async () => {
      try {
        setHealth(await api.health());
      } catch {
        setError("Server is not reachable. Is `npm run dev` running?");
      }
      await refreshLists();
    })();
  }, [refreshLists]);

  React.useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, stage]);

  const openConversation = React.useCallback(async (id: string) => {
    setActiveId(id);
    setError(null);
    try {
      const { messages: rows } = await api.conversation(id);
      setMessages(
        rows.map((m: MessageRecord) => ({
          id: `db-${m.id}`,
          role: m.role,
          text: m.content,
          openui: m.openuiLang,
        })),
      );
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const send = React.useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      setInput("");
      setBusy(true);
      setError(null);
      setStage("reading");
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text }]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await api.chat({ conversationId: activeId ?? undefined, text, tz }, (event, data) => {
          if (event === "status") {
            const d = data as { stage?: string };
            setStage(d.stage ?? "working");
          } else if (event === "reply") {
            const r = data as AgentReply;
            setActiveId(r.conversationId);
            // The conversation exists on the server by the time the reply lands,
            // so refresh immediately instead of only in the finally block.
            void refreshLists();
            setMessages((prev) => [
              ...prev,
              {
                id: `a-${r.createdAt}`,
                role: "assistant",
                text: r.text,
                openui: r.openui,
                meta: {
                  intent: r.intent,
                  latencyMs: r.latencyMs,
                  costUsd: r.costUsd,
                  digestRatio: r.digest?.ratio,
                },
              },
            ]);
          } else if (event === "error") {
            const d = data as { message?: string };
            setError(d.message ?? "The agent failed.");
          }
        }, controller.signal);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) setError(String(err));
      } finally {
        setBusy(false);
        setStage(null);
        abortRef.current = null;
        void refreshLists();
      }
    },
    [activeId, busy, tz, refreshLists],
  );

  // Suggestion chips rendered inside generated UI dispatch this event.
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail.trim()) void send(detail);
    };
    window.addEventListener("minimi:chip", handler as EventListener);
    return () => window.removeEventListener("minimi:chip", handler as EventListener);
  }, [send]);

  const newChat = () => {
    setActiveId(null);
    setMessages([]);
    setError(null);
  };

  const recheck = React.useCallback(
    async (shortlistId: string) => {
      if (busy) return;
      setBusy(true);
      setStage("re-checking items in parallel");
      setError(null);
      try {
        await api.recheck(shortlistId, { tz }, (event, data) => {
          if (event === "progress") {
            const p = data as { index?: number; total?: number; label?: string; type?: string };
            if (p.type === "item_done") setStage(`checked ${p.index}/${p.total}: ${p.label}`);
          } else if (event === "error") {
            setError((data as { message?: string }).message ?? "re-check failed");
          }
        });
        // The server persisted the run; ask the agent to narrate it as a turn so
        // the result lands in the conversation with evidence intact.
        await send("What changed?");
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
        setStage(null);
      }
    },
    [busy, send, tz],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">m</span>
          <div>
            <div className="brand-name">minimi</div>
            <div className="brand-sub">
              {health ? `${health.model} · ${tz}` : "connecting…"}
            </div>
          </div>
        </div>

        <button className="new-chat" onClick={newChat}>
          + New chat
        </button>

        <div className="side-section">
          <div className="side-label">Conversations</div>
          {conversations.length === 0 && <div className="side-empty">Nothing yet.</div>}
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`side-item ${c.id === activeId ? "active" : ""}`}
              onClick={() => void openConversation(c.id)}
            >
              <span className="side-item-title">{c.title || "Untitled"}</span>
              <span className="side-item-meta">
                {c.messageCount} msg · {c.tz}
              </span>
            </button>
          ))}
        </div>

        <div className="side-section">
          <div className="side-label">Shortlists</div>
          {shortlists.length === 0 && (
            <div className="side-empty">Ask “track …” to create one.</div>
          )}
          {shortlists.map((s) => (
            <button key={s.id} className="side-item" onClick={() => void recheck(s.id)}>
              <span className="side-item-title">{s.name}</span>
              <span className="side-item-meta">{s.itemCount ?? 0} items · re-check</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="main">
        {health?.offline && (
          <div className="banner info">
            Offline demo mode — the model and search calls are scripted, so content is illustrative.
            Add <code>DEEPSEEK_API_KEY</code> to <code>.env</code> and restart for real answers.
          </div>
        )}
        {health && !health.configured && !health.offline && (
          <div className="banner warn">
            DEEPSEEK_API_KEY is not set. Copy <code>.env.example</code> to <code>.env</code> and add
            your key, then restart.
          </div>
        )}
        {error && <div className="banner error">{error}</div>}

        <div className="scroller" ref={scroller}>
          {messages.length === 0 && (
            <div className="welcome">
              <h1>Ask about the world, or about what you already discussed.</h1>
              <p>
                One tool: web search. Answers arrive as structured UI with checkable sources.
                Memory is durable and timezone-aware — “show me yesterday’s conversations” works.
              </p>
              <div className="chips">
                {[
                  "What changed in the LLMLingua papers this year?",
                  "Track the pricing of AI coding agents",
                  "Show me the conversations from yesterday",
                ].map((c) => (
                  <button key={c} className="chip" onClick={() => void send(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="msg user">
                <div className="bubble">{m.text}</div>
              </div>
            ) : (
              <div key={m.id} className="msg assistant">
                {m.openui ? (
                  <Renderer response={m.openui} library={clientLibrary} isStreaming={false} />
                ) : (
                  <div className="card">{m.text}</div>
                )}
                {m.meta?.latencyMs != null && (
                  <div className="msg-meta">
                    {m.meta.intent} · {(m.meta.latencyMs / 1000).toFixed(1)}s
                    {m.meta.costUsd != null ? ` · $${m.meta.costUsd.toFixed(5)}` : ""}
                    {m.meta.digestRatio != null
                      ? ` · digest ${Math.round((1 - m.meta.digestRatio) * 100)}% smaller`
                      : ""}
                  </div>
                )}
              </div>
            ),
          )}

          {busy && (
            <div className="msg assistant">
              <div className="working">
                <span className="dot" />
                {STAGE_LABEL[stage ?? "working"] ?? stage}
              </div>
            </div>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="Ask anything, or “what changed?” to re-check a shortlist…"
            rows={2}
            disabled={busy}
          />
          <button type="submit" disabled={busy || !input.trim()}>
            {busy ? "…" : "Send"}
          </button>
        </form>
        <div className="tz-hint">
          Timezone <b>{tz}</b> is sent with every message, so “yesterday” means your yesterday.
        </div>
      </main>
    </div>
  );
}
