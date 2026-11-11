/**
 * API client.
 *
 * SSE over `fetch` rather than `EventSource`, because both streaming endpoints
 * are POSTs and `EventSource` cannot send a body. The reader is small but it has
 * to handle chunk boundaries properly: events are framed by a blank line and a
 * single network chunk can contain a partial frame.
 */

export interface Citation {
  id: number;
  url: string;
  title: string;
  domain: string;
  date: string | null;
  authority: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  modelCalls: number;
  searchRequests: number;
  searchResults: number;
}

export interface AgentReply {
  conversationId: string;
  intent: "answer" | "recall" | "change" | "chat";
  text: string;
  openui: string;
  citations: Citation[];
  usage: Usage;
  digest: { inputTokens: number; digestTokens: number; ratio: number; factsExtracted: number } | null;
  latencyMs: number;
  createdAt: number;
  costUsd: number;
  trace: Record<string, unknown>;
}

export interface ConversationSummary {
  id: string;
  title: string;
  tz: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface MessageRecord {
  id: number;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  openuiLang: string | null;
  citations: Citation[];
  createdAt: number;
}

export interface ShortlistSummary {
  id: string;
  name: string;
  tz: string;
  createdAt: number;
  updatedAt: number;
  itemCount?: number;
}

export interface RunProgress {
  type: "run_started" | "item_done" | "run_finished";
  runId: string;
  total?: number;
  index?: number;
  label?: string;
  status?: string;
  done?: number;
  failed?: number;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** POST and parse an SSE response, invoking `onEvent` per frame. */
async function postSSE(
  url: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.body) throw new Error("no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line; keep the trailing partial frame.
    let idx = buffer.indexOf("\n\n");
    while (idx >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length > 0) {
        const raw = dataLines.join("\n");
        try {
          onEvent(event, JSON.parse(raw));
        } catch {
          onEvent(event, raw);
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }
}

export const api = {
  health: () =>
    jsonFetch<{ ok: boolean; model: string; configured: boolean; offline: boolean }>("/api/health"),

  conversations: () => jsonFetch<{ conversations: ConversationSummary[] }>("/api/conversations"),

  conversation: (id: string) =>
    jsonFetch<{ conversation: ConversationSummary; messages: MessageRecord[] }>(
      `/api/conversations/${id}`,
    ),

  deleteConversation: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),

  shortlists: () => jsonFetch<{ shortlists: ShortlistSummary[] }>("/api/shortlists"),

  chat: (
    args: { conversationId?: string; text: string; tz: string },
    onEvent: (event: string, data: unknown) => void,
    signal?: AbortSignal,
  ) => postSSE("/api/chat", args, onEvent, signal),

  recheck: (
    shortlistId: string,
    args: { tz: string; resumeRunId?: string },
    onEvent: (event: string, data: unknown) => void,
    signal?: AbortSignal,
  ) => postSSE(`/api/shortlists/${shortlistId}/recheck`, args, onEvent, signal),

  resumeRun: (
    runId: string,
    onEvent: (event: string, data: unknown) => void,
    signal?: AbortSignal,
  ) => postSSE(`/api/runs/${runId}/resume`, {}, onEvent, signal),
};

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
