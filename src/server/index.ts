/**
 * HTTP surface.
 *
 * Transport choices:
 *  - **SSE for anything slow.** Both the chat turn and a shortlist re-check take
 *    seconds and have several stages; a spinner with no information is the worst
 *    possible UX for a slow, fallible pipeline. SSE gives stage progress without
 *    the complexity of a WebSocket.
 *  - **JSON for everything fast.** History, lists and health are plain REST.
 *  - **The server owns OpenUI Lang.** The client renders whatever document it is
 *    given and never constructs one, so the schema stays in one place.
 */

import express from "express";
import cors from "cors";
import { resolveTimeZone } from "./time.js";
import { Store } from "./memory.js";
import { Agent } from "./agent.js";
import { config, assertConfigured, costOf, logDebug } from "./config.js";
import { createShortlist, recheckShortlist } from "./shortlist.js";
import { openuiPromptCached } from "./openui.js";
import { emptyUsage } from "./config.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

const store = new Store(config.dbPath);
const agent = new Agent(store);

function sseInit(res: express.Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

function sseSend(res: express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Health / meta
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: config.model,
    configured: Boolean(config.apiKey) || config.offline,
    offline: config.offline,
    db: config.dbPath,
    openuiPromptChars: openuiPromptCached().length,
  });
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

app.post("/api/chat", async (req, res) => {
  const body = req.body as { conversationId?: string; text?: string; tz?: string };
  const text = (body.text ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const conversationId = body.conversationId || agent.newConversationId();
  const tz = resolveTimeZone(body.tz, "UTC");

  try {
    assertConfigured();
  } catch (err) {
    res.status(503).json({ error: String(err) });
    return;
  }

  sseInit(res);
  sseSend(res, "status", { stage: "reading", conversationId, tz });

  try {
    // Stage hints are emitted from the intent the agent is about to run. They are
    // advisory: the authoritative result arrives in the `reply` event.
    const pending = agent.respond({ conversationId, text, tz });

    const heartbeat = setInterval(() => sseSend(res, "status", { stage: "working" }), 4000);
    let reply;
    try {
      reply = await pending;
    } finally {
      clearInterval(heartbeat);
    }

    sseSend(res, "reply", {
      ...reply,
      costUsd: costOf(reply.usage),
    });
    logDebug("turn", {
      intent: reply.intent,
      latencyMs: reply.latencyMs,
      tokens: reply.usage.promptTokens + reply.usage.completionTokens,
      cacheHit: reply.usage.cacheHitTokens,
    });
    sseSend(res, "done", { conversationId });
  } catch (err) {
    sseSend(res, "error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

app.get("/api/conversations", (_req, res) => {
  res.json({ conversations: store.listConversations(50) });
});

app.get("/api/conversations/:id", (req, res) => {
  const conv = store.getConversation(req.params.id);
  if (!conv) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ conversation: conv, messages: store.listMessages(conv.id) });
});

app.delete("/api/conversations/:id", (req, res) => {
  store.db.prepare("DELETE FROM conversations WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Shortlists
// ---------------------------------------------------------------------------

app.get("/api/shortlists", (_req, res) => {
  res.json({ shortlists: store.listShortlists() });
});

app.get("/api/shortlists/:id", (req, res) => {
  const sl = store.getShortlist(req.params.id);
  if (!sl) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ shortlist: sl });
});

app.post("/api/shortlists", async (req, res) => {
  const body = req.body as { request?: string; tz?: string };
  const request = (body.request ?? "").trim();
  if (!request) {
    res.status(400).json({ error: "request is required" });
    return;
  }
  try {
    const tz = resolveTimeZone(body.tz, "UTC");
    const created = await createShortlist(store, {
      request,
      tz,
      conversationId: null,
      today: new Date().toLocaleString("en-CA", { timeZone: tz }).slice(0, 10),
    });
    res.json({ ...created, costUsd: costOf(created.usage) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/shortlists/:id/recheck", async (req, res) => {
  const body = req.body as { tz?: string; resumeRunId?: string; stream?: boolean };
  const shortlist = store.getShortlist(req.params.id);
  if (!shortlist) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const tz = resolveTimeZone(body.tz, shortlist.tz);

  if (body.stream === false) {
    try {
      const run = await recheckShortlist(store, {
        shortlistId: shortlist.id,
        tz,
        resumeRunId: body.resumeRunId,
      });
      res.json({ ...run, costUsd: costOf(run.usage) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  sseInit(res);
  try {
    const run = await recheckShortlist(store, {
      shortlistId: shortlist.id,
      tz,
      resumeRunId: body.resumeRunId,
      onProgress: (e) => sseSend(res, "progress", e),
    });
    sseSend(res, "result", { ...run, costUsd: costOf(run.usage) });
  } catch (err) {
    sseSend(res, "error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
});

app.get("/api/runs", (_req, res) => {
  res.json({ runs: store.listRuns(20) });
});

app.get("/api/runs/:id", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "not found" });
    return;
  }
  // Resume is an explicit action, not automatic on read: a run may have been
  // abandoned deliberately, and silently restarting spend on a GET is surprising.
  const resumable = store.resumableRunItems(run.id).length;
  res.json({ run, resumable });
});

app.post("/api/runs/:id/resume", async (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const shortlist = store.getShortlist(run.shortlistId);
  if (!shortlist) {
    res.status(404).json({ error: "shortlist not found" });
    return;
  }
  sseInit(res);
  try {
    const resumed = await recheckShortlist(store, {
      shortlistId: shortlist.id,
      tz: shortlist.tz,
      resumeRunId: run.id,
      onProgress: (e) => sseSend(res, "progress", e),
    });
    sseSend(res, "result", { ...resumed, costUsd: costOf(resumed.usage) });
  } catch (err) {
    sseSend(res, "error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

app.get("/api/memories", (req, res) => {
  const term = String(req.query.q ?? "").trim();
  res.json({ memories: term ? store.findMemories(term, 50) : [] });
});

// ---------------------------------------------------------------------------

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[minimi] unhandled", err);
  if (!res.headersSent) res.status(500).json({ error: String(err) });
});

export { app };

// On Vercel the platform owns the listener; binding a port would fail the deploy.
const isServerless = Boolean(process.env.VERCEL);
export const server = isServerless
  ? null
  : app.listen(config.port, () => {
  const usage = emptyUsage();
  console.log(`minimi server listening on http://127.0.0.1:${config.port}`);
  console.log(`  model:  ${config.model}`);
  console.log(`  db:     ${config.dbPath}`);
  console.log(`  ui:     ${openuiPromptCached().length} chars of OpenUI contract`);
  if (config.offline) {
    console.warn("  OFFLINE MODE: scripted backend, no network. Not a quality demo.");
  } else if (!config.apiKey) {
    console.warn("  WARNING: DEEPSEEK_API_KEY is not set — /api/chat will return 503.");
  }
      void usage;
    });

function shutdown(): void {
  server?.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
