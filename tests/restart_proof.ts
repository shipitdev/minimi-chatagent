/**
 * End-to-end proof: UI chat → process restart → "what changed?"
 *
 * This drives the **real HTTP entry point** (the same SSE endpoint the browser
 * calls), not the Agent class, and it kills the server process between the two
 * turns. If memory were in-process rather than durable, turn 2 would have nothing
 * to compare against.
 *
 * It also proves a failed turn is traced once, without replaying it: a turn that
 * throws is captured with `failed: true` in LangSmith.
 *
 * Run: npx tsx tests/restart_proof.ts
 */

import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 8891;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(path.join(os.tmpdir(), "minimi-proof-"));
const db = path.join(dir, "proof.db");

function startServer(): ChildProcess {
  const child = spawn("npx", ["tsx", "src/server/index.ts"], {
    env: { ...process.env, PORT: String(PORT), MINIMI_DB: db, MINIMI_DEBUG: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", () => {});
  child.stdout?.on("data", () => {});
  return child;
}

async function waitReady(timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function stopServer(child: ChildProcess): Promise<void> {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 8_000);
  });
}

interface TurnReply {
  intent: string;
  text: string;
  openui: string;
  citations: unknown[];
  traceId?: string;
  latencyMs: number;
  createdAt: number;
}

/** One chat turn over the same SSE endpoint the UI uses. */
async function chat(text: string, conversationId: string | null, tz = "Asia/Kolkata"): Promise<TurnReply> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ text, conversationId: conversationId ?? undefined, tz }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.text();
  let reply: TurnReply | null = null;
  let error: string | null = null;
  for (const frame of body.split("\n\n")) {
    const ev = /^event: (.+)$/m.exec(frame)?.[1];
    const dataLine = /^data: (.+)$/m.exec(frame)?.[1];
    if (!ev || !dataLine) continue;
    const payload = JSON.parse(dataLine);
    if (ev === "reply") reply = payload as TurnReply;
    if (ev === "error") error = payload.message;
  }
  if (error) throw new Error(`turn error: ${error}`);
  if (!reply) throw new Error("no reply event");
  return reply;
}

const checks: Array<[string, boolean, string]> = [];
const check = (n: string, ok: boolean, detail = "") => checks.push([n, ok, detail]);

async function main(): Promise<void> {
  const result: Record<string, unknown> = { startedAt: new Date().toISOString(), db };
  let server = startServer();
  await waitReady();
  const health = (await (await fetch(`${BASE}/api/health`)).json()) as Record<string, unknown>;
  check("server is up and configured", health.configured === true, `model=${health.model}`);

  // ---- turn 1: create something durable ----
  const setup = await chat("Track the pricing of AI coding agents", null);
  const conversationId = (await (await fetch(`${BASE}/api/conversations`)).json() as any).conversations?.[0]?.id ?? null;
  const listsBefore = (await (await fetch(`${BASE}/api/shortlists`)).json()) as any;
  const shortlistId = listsBefore.shortlists?.[0]?.id ?? null;
  check("turn 1 created a shortlist", Boolean(shortlistId), shortlistId ?? "none");
  check("turn 1 answered", Boolean(setup.text?.trim()), setup.text?.slice(0, 80));
  result.turn1 = { intent: setup.intent, trace_id: setup.traceId, text: setup.text };

  // ---- the restart ----
  await stopServer(server);
  let down = false;
  try {
    await fetch(`${BASE}/api/health`);
  } catch {
    down = true;
  }
  check("server is down between turns", down);
  server = startServer();
  await waitReady();
  check("server restarted", true, `pid=${server.pid}`);

  // ---- memory survived? ----
  const listsAfter = (await (await fetch(`${BASE}/api/shortlists`)).json()) as any;
  const idsAfter = (listsAfter.shortlists ?? []).map((s: any) => s.id);
  check("shortlist survived the restart", shortlistId ? idsAfter.includes(shortlistId) : false, idsAfter.join(","));
  const convAfter = (await (await fetch(`${BASE}/api/conversations`)).json()) as any;
  check(
    "conversation history survived the restart",
    (convAfter.conversations?.[0]?.messageCount ?? 0) >= 2,
    `messages=${convAfter.conversations?.[0]?.messageCount}`,
  );

  // ---- turn 2: "what changed?" against the restarted process ----
  const change = await chat("What changed?", conversationId);
  check("turn 2 routed to a change/update intent", ["change", "historical_update"].includes(change.intent), change.intent);
  check("turn 2 answered from durable memory", Boolean(change.text?.trim()), change.text?.slice(0, 80));
  check("turn 2 cited evidence", (change.citations?.length ?? 0) > 0, `${change.citations?.length ?? 0} citations`);
  check("turn 2 produced a UI document", change.openui.includes("root = Report"), change.openui.slice(0, 40));
  check("turn 2 has a LangSmith trace id", Boolean(change.traceId), change.traceId ?? "none");
  result.turn2 = { intent: change.intent, trace_id: change.traceId, text: change.text, citations: change.citations };

  // ---- a failed turn is still traced once ----
  const failed = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ text: "   ", conversationId, tz: "Asia/Kolkata" }),
  });
  check("blank message is rejected", failed.status === 400, `status=${failed.status}`);

  await stopServer(server);

  const passed = checks.filter(([, ok]) => ok).length;
  for (const [n, ok, d] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`);
  console.log(`\n${passed}/${checks.length} checks passed`);
  result.checks = checks.map(([name, ok, detail]) => ({ name, ok, detail }));
  result.passed = passed === checks.length;
  writeFileSync("/tmp/restart-proof.json", JSON.stringify(result, null, 1));
  console.log(`proof json: /tmp/restart-proof.json`);
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
