/**
 * Publish the golden set to LangSmith and run it as an experiment.
 *
 * This is what makes the eval reviewable in the LangSmith UI rather than only in a
 * JSON file: each case becomes a dataset example, each run becomes an experiment
 * trace linked to its example, and the runner's structural checks become feedback
 * scores so the Experiments table can be sorted by them.
 *
 * One dataset per split, because the splits have different semantics (replay with a
 * frozen clock vs live web) and mixing them would make the comparison meaningless.
 *
 * Run: npm run ls:experiment -- --split holdout
 */

import "dotenv/config";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";
import { Store, type EvidenceDoc, type ImportedTurn } from "../src/server/memory.js";
import { Agent } from "../src/server/agent.js";
import type { SearchResponse } from "../src/server/deepseek.js";
import { canonicalUrl } from "./golden_checks.js";

interface Fixture {
  id?: string;
  url?: string;
  title?: string;
  excerpt?: string;
  aliases?: string[];
  observed_at?: string | null;
  error?: string;
}
interface Turn {
  id: string;
  thread_id: string;
  timestamp: string;
  user: string;
  assistant: string;
  evidence?: Fixture[];
}
interface Case {
  id: string;
  split: string;
  category: string;
  mode: string;
  now?: string;
  timezone: string;
  history: Turn[];
  prompt: string;
  search_fixtures: Fixture[];
  restart_before_prompt: boolean;
  gold: {
    expected_route: string;
    required_turn_ids: string[];
    query_entities: string[];
    criteria: Array<{ text: string; evidence_ids: string[]; acceptable_urls: string[] }>;
  };
}

const alnum = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function replaySearch(fixtures: Fixture[]) {
  return async (query: string): Promise<SearchResponse> => {
    const q = alnum(query);
    const matched = fixtures.filter((f) => (f.aliases ?? []).some((a) => alnum(a) && q.includes(alnum(a))));
    const usable = matched.filter((m) => !m.error && m.excerpt);
    if (usable.length === 0 && matched.length > 0) throw new Error(matched[0]!.error ?? "provider error");
    const results = usable.map((f) => ({
      title: f.title ?? f.url ?? "source",
      url: f.url ?? "",
      snippet: (f.excerpt ?? "").slice(0, 180),
      summary: f.excerpt ?? "",
      date: f.observed_at ?? null,
      authority: 3,
      rerankScore: 2.5,
      siteName: null,
    }));
    return {
      results,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        modelCalls: 0,
        searchRequests: results.length > 0 ? 1 : 0,
        searchAttempts: 1,
        searchResults: results.length,
      },
    };
  };
}

const ROUTE_MAP: Record<string, string> = {
  chat: "direct",
  answer: "research",
  historical_update: "historical_update",
  change: "historical_update",
  recall: "recall",
  clarify: "clarify",
};

async function runCase(c: Case) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "minimi-ls-"));
  const store = new Store(path.join(dir, "a.db"));
  try {
    for (const t of c.history ?? []) {
      const imported: ImportedTurn = {
        id: t.id,
        threadId: t.thread_id,
        ts: Date.parse(t.timestamp),
        tz: c.timezone,
        user: t.user,
        assistant: t.assistant,
        evidence: (t.evidence ?? []).map(
          (e): EvidenceDoc => ({
            id: e.id ?? e.url ?? "",
            url: e.url ?? "",
            title: e.title ?? "",
            excerpt: e.excerpt ?? "",
            aliases: e.aliases ?? [],
            observedAt: e.observed_at ?? null,
            effectiveAt: null,
          }),
        ),
      };
      store.importTurn(imported);
    }
    const nowMs = c.now ? Date.parse(c.now) : Date.now();
    const agent = new Agent(store, {
      now: () => nowMs,
      ...(c.mode === "replay"
        ? {
            search: replaySearch(c.search_fixtures ?? []),
            fetch: async (url: string) => {
              throw new Error(`replay: no network fetch for ${url}`);
            },
          }
        : {}),
    });
    const reply = await agent.respond({ conversationId: `ls-${c.id}`, text: c.prompt, tz: c.timezone, now: nowMs });
    return {
      answer: reply.text,
      route: ROUTE_MAP[reply.intent] ?? reply.intent,
      selected_turn_ids: reply.selectedTurnIds,
      search_queries: reply.searchQueries,
      citations: reply.citations.map((x) => ({ id: x.url, url: x.url })),
      model_calls: reply.usage.modelCalls,
      latency_ms: Math.round(reply.latencyMs),
      input_tokens: reply.usage.promptTokens,
      output_tokens: reply.usage.completionTokens,
      cost_usd: Number((reply.usage as unknown as { cost?: number }).cost ?? 0),
    };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a plain-function evaluator that scores against the example's gold fields. */
function along(key: string, score: (g: Case["gold"], out: any) => number) {
  // `name` is read-only on functions, so the key travels in the closure only.
  return (run: any, example: any) => ({ key, score: score(gold(example), run.outputs) });
}

/** Example outputs carry the gold fields directly (uploaded above). */
function gold(example: any): Case["gold"] {
  const o = example?.outputs ?? {};
  return {
    expected_route: o.expected_route,
    required_turn_ids: o.required_turn_ids ?? [],
    query_entities: o.query_entities ?? [],
    criteria: o.criteria ?? [],
  };
}

function scoreRoute(gold: Case["gold"], out: any): number {
  return out?.route === gold.expected_route ? 1 : 0;
}
function scoreHistory(gold: Case["gold"], out: any): number {
  if (!gold.required_turn_ids?.length) return 1;
  const sel = new Set(out?.selected_turn_ids ?? []);
  return gold.required_turn_ids.every((id) => sel.has(id)) ? 1 : 0;
}
function scoreSearch(gold: Case["gold"], out: any): number {
  const expected = gold.expected_route === "research" || gold.expected_route === "historical_update";
  return Boolean((out?.search_queries ?? []).length) === expected ? 1 : 0;
}
function scoreSources(gold: Case["gold"], out: any): number {
  const required = gold.criteria.filter((c) => c.evidence_ids?.length || c.acceptable_urls?.length);
  if (required.length === 0) return 1;
  const cited = new Set((out?.citations ?? []).map((c: any) => c.id));
  const urls = new Set((out?.citations ?? []).map((c: any) => canonicalUrl(c.url)));
  let hit = 0;
  for (const c of required) {
    if (c.evidence_ids?.length) {
      if (c.evidence_ids.every((id) => cited.has(id))) hit++;
    } else if (c.acceptable_urls?.some((u) => urls.has(canonicalUrl(u)))) hit++;
  }
  return hit / required.length;
}

async function main(): Promise<void> {
  const split = (process.argv[process.argv.indexOf("--split") + 1] ?? "holdout") as string;
  const all = JSON.parse(readFileSync("evals/golden/cases.json", "utf8")) as Case[];
  const cases = all.filter((c) => c.split === split);
  if (cases.length === 0) throw new Error(`no cases for split ${split}`);

  const client = new Client();
  const datasetName = `minimi-golden-${split}`;

  let datasetId: string;
  try {
    const existing = await client.readDataset({ datasetName });
    datasetId = existing.id;
    console.log(`dataset exists: ${datasetName}`);
  } catch {
    const created = await client.createDataset(datasetName, {
      description: `minimi golden ${split} split (${cases.length} cases)`,
    });
    datasetId = created.id;
    await client.createExamples({
      datasetId,
      inputs: cases.map((c) => ({
        case_id: c.id,
        prompt: c.prompt,
        timezone: c.timezone,
        mode: c.mode,
        history: c.history,
        search_fixtures: c.search_fixtures,
        restart_before_prompt: c.restart_before_prompt,
        ...(c.now ? { now: c.now } : {}),
      })),
      outputs: cases.map((c) => ({
        expected_route: c.gold.expected_route,
        required_turn_ids: c.gold.required_turn_ids,
        query_entities: c.gold.query_entities,
        criteria: c.gold.criteria,
      })),
      metadata: cases.map((c) => ({ case_id: c.id, split, category: c.category })),
    });
    console.log(`dataset created: ${datasetName} (${cases.length} examples)`);
  }

  // The SDK's two `evaluate` overloads (standard vs comparative) are selected by
  // option shape; ours is the standard one but does not satisfy the overload's
  // narrowing, so the call is cast rather than given a misleading config.
  const results = await (evaluate as any)(
    async (input: Record<string, any>) => {
      const c = cases.find((x) => x.id === input.case_id);
      if (!c) throw new Error(`unknown case ${input.case_id}`);
      return runCase(c);
    },
    {
      data: datasetName,
      experimentPrefix: `minimi-${split}`,
      description: `golden ${split} split`,
      metadata: { split, contract: "2026-11-11.v2" },
      maxConcurrency: 2,
      evaluators: [
        // The JS SDK takes plain functions (unlike Python's objects).
        along("route_match", (g, o) => scoreRoute(g, o)),
        along("history_recall", (g, o) => scoreHistory(g, o)),
        along("search_when_needed", (g, o) => scoreSearch(g, o)),
        along("source_coverage", (g, o) => scoreSources(g, o)),
      ],
    },
  );

  console.log(`\nexperiment finished for ${cases.length} ${split} cases`);
  console.log(`open: https://smith.langchain.com/o/-/datasets/${datasetId}/experiments`);
  void results;
  await client.flush?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
