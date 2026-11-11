/**
 * Live Flash smoke test.
 *
 * One real turn against DeepSeek with real web search, asserting the things a
 * production entry point must guarantee: an answer exists, the UI document parses,
 * every citation resolves to a retrieved URL, and telemetry is populated. It is
 * deliberately small — it is a canary, not an eval.
 *
 * Run: npm run smoke
 */

import { Store } from "../src/server/memory.js";
import { Agent } from "../src/server/agent.js";
import { validateLang } from "../src/server/openui.js";
import { costOf } from "../src/server/config.js";
import { tracingEnabled } from "../src/server/tracing.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const QUESTION = "What are the current per-million-token input and output prices for the DeepSeek flash model?";
const TZ = "Asia/Kolkata";

const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => checks.push([name, ok, detail]);

const dir = mkdtempSync(path.join(os.tmpdir(), "minimi-smoke-"));
const store = new Store(path.join(dir, "smoke.db"));
const agent = new Agent(store, { now: () => Date.now() });

console.log(`tracing: ${tracingEnabled() ? "on" : "off"}`);
console.log(`question: ${QUESTION}\n`);

const t0 = Date.now();
const reply = await agent.respond({ conversationId: "smoke", text: QUESTION, tz: TZ });
const wall = Date.now() - t0;

check("answer is non-empty", reply.text.trim().length > 40, `${reply.text.length} chars`);
check("route is research", reply.intent === "answer", reply.intent);
check("at least one search ran", reply.searchQueries.length > 0, reply.searchQueries.join(" | "));
check("citations present", reply.citations.length > 0, `${reply.citations.length}`);
check(
  "every citation is a real URL",
  reply.citations.every((c) => /^https?:\/\//.test(c.url)),
  reply.citations.map((c) => c.url).slice(0, 3).join(" "),
);
check("UI document parses", validateLang(reply.openui).ok, validateLang(reply.openui).errors.join("; "));
check("model calls >= 1", reply.usage.modelCalls >= 1, String(reply.usage.modelCalls));
check("tokens accounted", reply.usage.promptTokens > 0, String(reply.usage.promptTokens));
check("answer carries a citation marker", /\[\d+\]/.test(reply.text), "");
check("latency under 30s", wall < 30_000, `${wall}ms`);

console.log(reply.text.slice(0, 700));
console.log("\nsources:");
for (const c of reply.citations.slice(0, 8)) console.log(`  [${c.id}] ${c.url}`);

console.log(
  `\nusage: in ${reply.usage.promptTokens} (cache hit ${reply.usage.cacheHitTokens}) ` +
    `out ${reply.usage.completionTokens} · calls ${reply.usage.modelCalls} · ` +
    `searches ${reply.searchQueries.length} · cost $${costOf(reply.usage).toFixed(5)} · ${wall}ms`,
);

let failed = 0;
console.log("");
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} smoke checks passed`);

store.close();
rmSync(dir, { recursive: true, force: true });
process.exitCode = failed === 0 ? 0 : 1;
