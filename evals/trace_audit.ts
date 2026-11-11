/**
 * Trace audit.
 *
 * The tracing contract is only worth having if something checks it. This script
 * reads the most recent turns back **from LangSmith** — not from local state — and
 * fails if a required metric is missing, if a span name is not in the contract, or
 * if the turn's aggregate disagrees with the spans underneath it.
 *
 * That last check is the one that catches silent under-reporting: a turn claiming
 * three model calls while only two `minimi.llm.chat` runs exist means a call is
 * invisible in the dashboard.
 *
 * Run: npm run trace:audit
 */

import "dotenv/config";
import { CONTRACT_VERSION, LLM_METRICS, RUN_NAMES, TURN_METRICS, TOOL_METRICS } from "../src/server/tracing.js";

const API = "https://api.smith.langchain.com/api/v1";
const KEY = process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY ?? "";
const PROJECT = process.env.LANGSMITH_PROJECT ?? "default";

interface Run {
  id: string;
  name: string;
  extra?: { metadata?: Record<string, unknown> };
  run_type: string;
  trace_id: string;
  parent_run_id: string | null;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown> | null;
  error?: string | null;
  start_time?: string;
  end_time?: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "x-api-key": KEY, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  if (!KEY) {
    console.error("LANGSMITH_API_KEY is not set; cannot audit.");
    process.exit(2);
  }

  const sessions = await api<Array<{ id: string; name: string }>>("/sessions?limit=100");
  const session = sessions.find((s) => s.name === PROJECT);
  if (!session) {
    console.error(`project "${PROJECT}" not found; have: ${sessions.map((s) => s.name).join(", ")}`);
    process.exit(2);
  }

  const { runs } = await api<{ runs: Run[] }>("/runs/query", {
    method: "POST",
    body: JSON.stringify({ session: [session.id], limit: Math.min(100, Number(process.env.AUDIT_LIMIT ?? 100)) }),
  });

  const byTrace = new Map<string, Run[]>();
  for (const r of runs) {
    const arr = byTrace.get(r.trace_id) ?? [];
    arr.push(r);
    byTrace.set(r.trace_id, arr);
  }

  // Only traces that declare the current contract. Older ones are history, not
  // defects, and reporting them as missing metrics would train people to ignore the
  // audit.
  const contractTurns = runs.filter(
    (r) =>
      r.name === RUN_NAMES.turn &&
      (r.extra?.metadata as Record<string, unknown>)?.observability_contract === CONTRACT_VERSION &&
      // A failed turn is expected to lack answer metrics; it is audited separately
      // for its error, not for missing numbers.
      (r.outputs as Record<string, unknown> | null)?.failed !== true,
  );
  // Child spans are posted asynchronously, so a turn seconds old can look
  // incomplete through no fault of the writer. Audit only settled turns.
  const SETTLE_MS = Number(process.env.AUDIT_SETTLE_MS ?? 90_000);
  const settled = contractTurns.filter((r) => {
    const t = Date.parse(r.start_time ?? "");
    return Number.isFinite(t) && Date.now() - t > SETTLE_MS;
  });
  const turnRoots = (settled.length > 0 ? settled : contractTurns)
    .sort((a, b) => (b.start_time ?? "").localeCompare(a.start_time ?? ""))
    .slice(0, Number(process.env.AUDIT_TURNS ?? 5));

  if (turnRoots.length === 0) {
    console.error(
      `no "${RUN_NAMES.turn}" runs with contract ${CONTRACT_VERSION} in project "${PROJECT}".\n` +
        `Run \`npm run smoke\` (or a few real turns) and retry.`,
    );
    process.exit(2);
  }

  const knownNames = new Set<string>(Object.values(RUN_NAMES));
  const problems: string[] = [];
  const rows: Array<Record<string, string>> = [];

  for (const root of turnRoots) {
    const children = (byTrace.get(root.trace_id) ?? []).filter((r) => r.id !== root.id);
    const out = (root.outputs ?? {}) as Record<string, unknown>;
    const missing = TURN_METRICS.filter((k) => out[k] === undefined || out[k] === null);

    // Unknown span names mean the contract has drifted.
    for (const c of children) {
      if (!knownNames.has(c.name)) problems.push(`${root.id.slice(-8)}: unexpected span name "${c.name}"`);
    }

    const llmChildren = children.filter((c) => c.name === RUN_NAMES.llm);
    const searchChildren = children.filter((c) => c.name === RUN_NAMES.search);

    // Aggregate must match reality, or the dashboard under-reports.
    const calls = Number(out.model_calls ?? -1);
    if (calls > 0 && calls !== llmChildren.length) {
      problems.push(
        `${root.id.slice(-8)}: model_calls=${out.model_calls} but ${llmChildren.length} llm spans`,
      );
    }
    const scalls = Number(out.search_calls ?? -1);
    // Only under-reporting is a defect: a turn may show extra attempted spans.
    if (scalls > searchChildren.length) {
      problems.push(
        `${root.id.slice(-8)}: search_calls=${out.search_calls} but ${searchChildren.length} search spans`,
      );
    }
    const zeroCallTurn = calls === 0 && scalls === 0;
    if (!zeroCallTurn && Number(out.cost_usd ?? 0) <= 0) {
      problems.push(`${root.id.slice(-8)}: cost_usd is zero on a turn that called a model`);
    }
    if (missing.length > 0) problems.push(`${root.id.slice(-8)}: turn missing ${missing.join(", ")}`);

    for (const llm of llmChildren) {
      const o = (llm.outputs ?? {}) as Record<string, unknown>;
      const miss = LLM_METRICS.filter((k) => o[k] === undefined || o[k] === null);
      if (miss.length > 0) problems.push(`${root.id.slice(-8)}: llm span missing ${miss.join(", ")}`);
      if (!o.usage_metadata) problems.push(`${root.id.slice(-8)}: llm span missing usage_metadata`);
      if (llm.error) problems.push(`${root.id.slice(-8)}: llm span errored: ${llm.error}`);
    }
    for (const tool of searchChildren) {
      const o = (tool.outputs ?? {}) as Record<string, unknown>;
      const miss = TOOL_METRICS.filter((k) => o[k] === undefined || o[k] === null);
      if (miss.length > 0) problems.push(`${root.id.slice(-8)}: search span missing ${miss.join(", ")}`);
    }

    rows.push({
      turn: root.id.slice(-8),
      route: String(out.route ?? "?"),
      llm: `${llmChildren.length}/${out.model_calls}`,
      search: `${searchChildren.length}/${out.search_calls}`,
      tokens: `${out.input_tokens ?? "?"}/${out.output_tokens ?? "?"}`,
      cache: String(out.cache_hit_tokens ?? "?"),
      cost: `$${Number(out.cost_usd ?? 0).toFixed(5)}`,
      ms: String(out.latency_ms ?? "?"),
      cites: String(out.citations ?? "?"),
      ui: out.ui_validation === true ? "ok" : "BAD",
    });
  }

  const failedTurns = runs.filter(
    (r) => r.name === RUN_NAMES.turn && (r.outputs as Record<string, unknown> | null)?.failed === true,
  );
  for (const f of failedTurns.slice(0, 3)) {
    const o = (f.outputs ?? {}) as Record<string, unknown>;
    if (!o.error) problems.push(`${f.id.slice(-8)}: failed turn recorded no error`);
  }
  console.log(
    `project: ${PROJECT} · auditing ${turnRoots.length} most recent successful turns` +
      (failedTurns.length ? ` · ${failedTurns.length} failed turn(s) traced with an error` : ""),
  );
  if (failedTurns.length) console.log(`failed-turn tracing: ok (${failedTurns.length} captured, no replay)\n`);
  else console.log("");
  const header = ["turn", "route", "llm", "search", "in/out", "cache", "cost", "ms", "cites", "ui"];
  console.log(header.map((h) => h.padEnd(9)).join(" "));
  for (const r of rows) {
    console.log(
      [r.turn, r.route, r.llm, r.search, r.tokens, r.cache, r.cost, r.ms, r.cites, r.ui]
        .map((v) => String(v).padEnd(9))
        .join(" "),
    );
  }

  console.log(`\nrequired turn metrics: ${TURN_METRICS.join(", ")}`);
  if (problems.length === 0) {
    console.log(`\nPASS — every audited turn reports all ${TURN_METRICS.length} metrics and its spans agree.`);
    return;
  }
  console.log(`\nFAIL — ${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
