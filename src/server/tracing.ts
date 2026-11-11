/**
 * Observability contract.
 *
 * The point of this file is that a trace can be **reviewed**, not merely produced.
 * Three things make that true:
 *
 * 1. **Fixed names.** Every run has one of five names (below). No name is built
 *    from a template or a function name, so filtering and grouping in LangSmith is
 *    predictable and a missing span is obvious.
 * 2. **Fixed metric keys.** Every model span emits the same keys, defined once in
 *    `METRIC_KEYS`. A reviewer (or `npm run trace:audit`) checks one list rather
 *    than guessing what a given span happened to include.
 * 3. **Metrics on the turn, not only on children.** A turn carries the aggregate —
 *    model calls, search calls, tokens, cache hits, cost, latency, route, citations
 *    — so the summary row is answerable without expanding every child.
 *
 * LangSmith cost note: LangSmith computes cost automatically for models it knows.
 * DeepSeek is not in that table, so every LLM span also reports an explicit
 * `cost_usd` computed from the API's own token counts. That value is authoritative
 * for this app and is what the dashboard shows.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { RunTree } from "langsmith";

/**
 * Version of the observability contract. Bumped when names or metric keys change.
 *
 * Written into every turn's metadata, which lets the audit ignore traces produced
 * under an older contract instead of reporting them as defects forever.
 */
export const CONTRACT_VERSION = "2026-11-11.v2";

/** The complete set of run names. Nothing else may be emitted. */
export const RUN_NAMES = {
  /** Root: one user turn. run_type "chain". */
  turn: "minimi.turn",
  /** One model completion. run_type "llm". */
  llm: "minimi.llm.chat",
  /** One web_search call. run_type "tool". */
  search: "minimi.tool.web_search",
  /** One page fetch behind the search tool. run_type "tool". */
  fetch: "minimi.tool.fetch_page",
  /** One shortlist re-check batch. run_type "chain". */
  recheck: "minimi.shortlist.recheck",
  /** Pipeline steps, each visible by name in LangSmith. */
  route: "minimi.route",
  memory: "minimi.memory",
  plan: "minimi.plan",
  digest: "minimi.digest",
  answer: "minimi.answer",
  save: "minimi.save",
} as const;

export type RunName = (typeof RUN_NAMES)[keyof typeof RUN_NAMES];

/**
 * Metric keys that the audit requires on every turn. Kept as data so the audit and
 * the writer cannot drift apart.
 */
export const TURN_METRICS = [
  "route",
  "model_calls",
  "search_calls",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cache_hit_tokens",
  "cost_usd",
  "latency_ms",
  "citations",
  "selected_turn_ids",
  "search_queries",
  "ui_validation",
] as const;

/** Metric keys required on every LLM span. */
export const LLM_METRICS = [
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cache_hit_tokens",
  "cost_usd",
  "latency_ms",
] as const;

/** Metric keys required on every tool span. */
export const TOOL_METRICS = ["latency_ms", "results", "cost_usd"] as const;

const store = new AsyncLocalStorage<RunTree>();

let enabled: boolean | null = null;

export function tracingEnabled(): boolean {
  if (enabled !== null) return enabled;
  const key = process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY ?? "";
  const flag = (process.env.LANGSMITH_TRACING ?? process.env.LANGCHAIN_TRACING_V2 ?? "true").toLowerCase();
  enabled = Boolean(key) && flag !== "false" && flag !== "0";
  return enabled;
}

/** Reset for tests. */
export function resetTracingCache(): void {
  enabled = null;
}

export interface UsageLike {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  modelCalls: number;
  searchRequests: number;
  searchResults: number;
}

/**
 * The canonical usage block. Both the LangSmith UI (which reads
 * `usage_metadata`) and our own audit read this shape.
 */
export function usageMetadata(u: UsageLike) {
  return {
    input_tokens: u.promptTokens,
    output_tokens: u.completionTokens,
    total_tokens: u.promptTokens + u.completionTokens,
    cache_hit_tokens: u.cacheHitTokens,
    cache_miss_tokens: u.cacheMissTokens,
    input_token_details: { cache_read: u.cacheHitTokens, cache_miss: u.cacheMissTokens },
    model_calls: u.modelCalls,
    search_requests: u.searchRequests,
  };
}

export interface SpanOptions {
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface HandledRun {
  end(outputs?: Record<string, unknown>, error?: unknown): Promise<void>;
}

const NOOP: HandledRun = { end: async () => {} };

function tags(base: string[]): string[] {
  const t = ["minimi", ...base];
  const split = process.env.MINIMI_EVAL_SPLIT;
  if (split) t.push(`split:${split}`);
  return t;
}

/** Start a named child run. Safe (and free) when tracing is disabled. */
export function span(
  name: RunName,
  runType: "llm" | "tool" | "chain",
  inputs: Record<string, unknown> = {},
  opts: SpanOptions = {},
): HandledRun {
  if (!tracingEnabled()) return NOOP;
  const parent = store.getStore();
  try {
    const base = {
      name,
      run_type: runType,
      inputs,
      tags: tags(opts.tags ?? []),
      extra: opts.metadata ? { metadata: opts.metadata } : undefined,
    };
    const run = parent ? parent.createChild(base) : new RunTree(base);
    void run.postRun().catch(() => {});
    return {
      async end(outputs, error) {
        try {
          if (error) {
            const e = error instanceof Error ? error : new Error(String(error));
            run.end(undefined, `${e.name}: ${e.message}`);
          } else {
            run.end(outputs ?? {});
          }
          await run.patchRun();
        } catch {
          /* observability must never fail a turn */
        }
      },
    };
  } catch {
    return NOOP;
  }
}

/**
 * A model span that always reports the full metric set, so a reviewer never has to
 * ask "did this one include cost?".
 */
export function llmSpan(args: {
  model: string;
  stage: string;
  inputs: Record<string, unknown>;
}): {
  end: (m: { usage: UsageLike; latencyMs: number; costUsd: number; outputChars: number }) => Promise<void>;
  fail: (err: unknown) => Promise<void>;
  run: HandledRun;
} {
  const run = span(RUN_NAMES.llm, "llm", { ...args.inputs, stage: args.stage }, {
    tags: ["component:llm", `stage:${args.stage}`],
    metadata: { ls_provider: "deepseek", ls_model_name: args.model, stage: args.stage },
  });
  return {
    run,
    async end(m) {
      await run.end({
        stage: args.stage,
        output_chars: m.outputChars,
        // LangSmith's UI reads `usage_metadata`; the keys are also flattened to the
        // top level so a reviewer (and the audit) can read a run's outputs directly
        // without knowing the nesting convention.
        ...usageMetadata(m.usage),
        usage_metadata: usageMetadata(m.usage),
        // Explicit because LangSmith has no price row for this model.
        cost_usd: round(m.costUsd),
        latency_ms: Math.round(m.latencyMs),
        model: args.model,
      });
    },
    async fail(err) {
      await run.end(undefined, err);
    },
  };
}

/**
 * A named pipeline step (route, memory, plan, digest, answer, save).
 *
 * These exist so a reviewer can read a turn's *structure* without decoding model
 * prompts: which route was chosen, which memory was consulted, what the digest kept,
 * what was saved. `end` is idempotent so a step can be closed from a `finally`
 * block, which is how failed turns still produce a complete, reviewable trace
 * instead of an orphaned partial one.
 */
export function step(
  name: RunName,
  inputs: Record<string, unknown> = {},
): { end: (outputs?: Record<string, unknown>) => void; fail: (err: unknown) => void } {
  const run = span(name, "chain", inputs, { tags: ["component:pipeline-step"] });
  let closed = false;
  const finish = (outputs: Record<string, unknown> | undefined, error?: unknown) => {
    if (closed) return;
    closed = true;
    void run.end(outputs, error);
  };
  return {
    end: (outputs) => finish(outputs ?? {}),
    fail: (err) => finish(undefined, err),
  };
}

/** A tool span with the tool metric set. */
export function toolSpan(args: {
  name: typeof RUN_NAMES.search | typeof RUN_NAMES.fetch;
  inputs: Record<string, unknown>;
}): {
  end: (m: { latencyMs: number; results: number; costUsd: number; extra?: Record<string, unknown> }) => Promise<void>;
  fail: (err: unknown) => Promise<void>;
} {
  const run = span(args.name, "tool", args.inputs, {
    tags: ["component:tool", args.name], 
    metadata: { provider: "deepseek" },
  });
  return {
    async end(m) {
      await run.end({
        ...(m.extra ?? {}),
        results: m.results,
        latency_ms: Math.round(m.latencyMs),
        cost_usd: round(m.costUsd),
      });
    },
    async fail(err) {
      await run.end(undefined, err);
    },
  };
}

export interface TurnSummary {
  route: string;
  model_calls: number;
  search_calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_hit_tokens: number;
  cost_usd: number;
  latency_ms: number;
  citations: number;
  selected_turn_ids: string[];
  search_queries: string[];
  ui_validation: boolean;
  digest_ratio: number | null;
  [key: string]: unknown;
}

/**
 * Wrap one turn. `summarize` must return the full `TurnSummary`; the audit treats a
 * missing key as a defect rather than a warning.
 */
export async function withTurnTrace<T>(
  meta: { inputs: Record<string, unknown>; metadata?: Record<string, unknown>; tags?: string[] },
  fn: () => Promise<T>,
  summarize: (result: T) => TurnSummary,
  /** Receives the LangSmith trace id synchronously, for correlation in reports. */
  onTraceId?: (id: string) => void,
): Promise<T> {
  if (!tracingEnabled()) return fn();
  try {
    const root = new RunTree({
      name: RUN_NAMES.turn,
      run_type: "chain",
      inputs: meta.inputs,
      tags: tags(["component:pipeline", ...(meta.tags ?? [])]),
      extra: {
        metadata: {
          ...(meta.metadata ?? {}),
          observability_contract: CONTRACT_VERSION,
        },
      },
    });
    void root.postRun().catch(() => {});
    onTraceId?.(root.id);
    try {
      const result = await store.run(root, fn);
      try {
        root.end(summarize(result));
        await root.patchRun();
      } catch {
        /* ignore */
      }
      return result;
    } catch (err) {
      // A failed turn must still appear once, complete with its error, so it can be
      // reviewed without replaying it.
      try {
        const e = err instanceof Error ? err : new Error(String(err));
        root.end({ failed: true, error: e.message }, `${e.name}: ${e.message}`);
        await root.patchRun();
      } catch {
        /* ignore */
      }
      throw err;
    }
  } catch {
    return fn();
  }
}

/** Attach a named event (route decision, plan) to the current run. */
export function event(name: string, payload: Record<string, unknown>): void {
  if (!tracingEnabled()) return;
  const run = store.getStore();
  if (!run) return;
  try {
    run.addEvent({ name, ...payload });
  } catch {
    /* ignore */
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
