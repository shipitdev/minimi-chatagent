import { config, emptyUsage, logDebug, type Usage } from "./config.js";
import { offlineChat, offlineSearch } from "./offline.js";
import { llmSpan, toolSpan } from "./tracing.js";
import { costOf } from "./config.js";
import { RUN_NAMES } from "./tracing.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  usage: Usage;
  finishReason: string;
}

export class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Bounded concurrency limiter.
 *
 * Every outbound call goes through one of these. The account-level limits are
 * 100 QPS for search and 2500 concurrent model calls; more importantly, a
 * shortlist of 40 items fanned out without a limit will produce a burst that
 * gets rate-limited and then retried, which is slower than a bounded fan-out.
 */
export class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export const searchLimiter = new Limiter(12);
export const modelLimiter = new Limiter(8);

export async function chat(
  messages: ChatMessage[],
  opts: {
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
    thinking?: boolean;
    /** Logical stage, e.g. "route" | "plan" | "answer". Used for trace labelling. */
    stage?: string;
  } = {},
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1200,
    stream: false,
    thinking: { type: opts.thinking ? "enabled" : "disabled" },
  };
  if (opts.json) {
    body.response_format = { type: "json_object" };
    // DeepSeek rejects json_object mode with HTTP 400 unless the prompt mentions
    // JSON. Enforcing it here means a new prompt cannot fail at runtime for a
    // reason that has nothing to do with its content.
    if (!/json/i.test(messages.map((m) => m.content).join("\n"))) {
      const last = messages[messages.length - 1];
      if (last) last.content = `${last.content}\n\nReply with JSON only.`;
    }
  }

  if (config.offline) return offlineChat(messages);

  const started = performance.now();
  const trace = llmSpan({
    model: config.model,
    stage: opts.stage ?? "model",
    inputs: {
      messages: messages.length,
      prompt_chars: messages.reduce((n, m) => n + m.content.length, 0),
      json_mode: Boolean(opts.json),
    },
  });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await modelLimiter.run(() =>
        fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        }),
      );
      if (RETRYABLE.has(res.status)) {
        throw new DeepSeekError(`transient HTTP ${res.status}`, res.status);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new DeepSeekError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: Record<string, number>;
      };
      const u = data.usage ?? {};
      const usage: Usage = {
        ...emptyUsage(),
        promptTokens: Number(u.prompt_tokens ?? 0),
        completionTokens: Number(u.completion_tokens ?? 0),
        cacheHitTokens: Number(u.prompt_cache_hit_tokens ?? 0),
        cacheMissTokens: Number(u.prompt_cache_miss_tokens ?? 0),
        modelCalls: 1,
      };
      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? "";
      await trace.end({
        usage,
        latencyMs: performance.now() - started,
        costUsd: costOf(usage),
        outputChars: content.length,
      });
      logDebug("chat", {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cacheHit: usage.cacheHitTokens,
      });
      return { content, usage, finishReason: choice?.finish_reason ?? "" };
    } catch (err) {
      const status = err instanceof DeepSeekError ? err.status : undefined;
      if (status && !RETRYABLE.has(status)) {
        await trace.fail(err);
        throw err;
      }
      lastErr = err;
      if (attempt < 2) await sleep(400 * 2 ** attempt);
    }
  }
  throw new DeepSeekError(`chat failed after retries: ${String(lastErr)}`);
}

// ---------------------------------------------------------------------------
// The single tool
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  date: string | null;
  authority: number;
  rerankScore: number;
  siteName: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
  usage: Usage;
}

interface RawResult {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  date?: string | null;
  authority?: number | null;
  rerank_score?: number | null;
  site_name?: string | null;
}

export function normaliseResult(r: RawResult): SearchResult {
  return {
    title: (r.title ?? "").trim() || "(untitled)",
    url: (r.url ?? "").trim(),
    snippet: (r.snippet ?? "").trim(),
    summary: (r.summary ?? r.content ?? r.snippet ?? "").trim(),
    date: r.date ?? null,
    authority: typeof r.authority === "number" ? r.authority : -1,
    rerankScore: typeof r.rerank_score === "number" ? r.rerank_score : 0,
    siteName: r.site_name ?? null,
  };
}

/**
 * `web_search` — the agent's only tool.
 *
 * `count` does not affect price (billing is per successful request), so we
 * deliberately over-fetch and filter locally. Two searches at count=4 cost twice
 * as much as one search at count=8 that we rank ourselves.
 */
export async function webSearch(
  query: string,
  opts: { count?: number; oriQuestion?: string; needContent?: boolean } = {},
): Promise<SearchResponse> {
  const q = query.trim().slice(0, 128);
  if (!q) return { results: [], usage: emptyUsage() };
  if (config.offline) return offlineSearch(q);

  const started = performance.now();
  const trace = toolSpan({ name: RUN_NAMES.search, inputs: { query: q, count: opts.count ?? 8 } });

  const payload: Record<string, unknown> = {
    query: q,
    count: Math.min(50, Math.max(1, opts.count ?? 8)),
  };
  if (opts.oriQuestion) payload.ori_question = opts.oriQuestion.slice(0, 128);
  if (opts.needContent) payload.need_content = true;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await searchLimiter.run(() =>
        fetch(`${config.baseUrl}/v1/tools/search`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        }),
      );
      if (RETRYABLE.has(res.status)) {
        throw new DeepSeekError(`transient HTTP ${res.status}`, res.status);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new DeepSeekError(`search HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, text);
      }
      const data = (await res.json()) as { results?: RawResult[] };
      const results = (data.results ?? []).map(normaliseResult).filter((r) => r.url);
      const usage: Usage = {
        ...emptyUsage(),
        // Attempted and billable are different numbers: a request that returns
        // nothing is not billed, but it did happen and must appear as a span.
        searchAttempts: 1,
        searchRequests: results.length > 0 ? 1 : 0,
        searchResults: results.length,
      };
      logDebug("search", { query: q, results: results.length });
      await trace.end({
        latencyMs: performance.now() - started,
        results: results.length,
        costUsd: usage.searchRequests * config.price.perSearch,
        extra: { urls: results.slice(0, 8).map((r) => r.url) },
      });
      return { results, usage };
    } catch (err) {
      lastErr = err;
      const status = err instanceof DeepSeekError ? err.status : undefined;
      if (status && !RETRYABLE.has(status)) {
        await trace.fail(err);
        throw err;
      }
      if (attempt < 2) await sleep(300 * 2 ** attempt);
    }
  }
  throw new DeepSeekError(`search failed after retries: ${String(lastErr)}`);
}

/**
 * Fetch a page as Markdown through the provider's Fetch endpoint.
 *
 * This is **not** a second tool. The agent still has exactly one action —
 * `web_search` — and this is how that action works internally when the search index
 * cannot surface a known authoritative page. It is the same principle as
 * `need_content`: an implementation detail behind one tool, chosen by our code, not
 * a capability the model can invoke.
 */
export async function fetchPage(url: string): Promise<{ title: string; content: string }> {
  if (config.offline) throw new DeepSeekError("fetch is unavailable offline");
  const started = performance.now();
  const trace = toolSpan({ name: RUN_NAMES.fetch, inputs: { url } });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await searchLimiter.run(() =>
        fetch(`${config.baseUrl}/v1/tools/fetch`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(30_000),
        }),
      );
      if (RETRYABLE.has(res.status)) throw new DeepSeekError(`transient HTTP ${res.status}`, res.status);
      if (!res.ok) throw new DeepSeekError(`fetch HTTP ${res.status}`, res.status, await res.text());
      const data = (await res.json()) as { title?: string; content?: string };
      await trace.end({
        latencyMs: performance.now() - started,
        results: 1,
        costUsd: config.price.perFetch,
        extra: { title: data.title ?? "", chars: (data.content ?? "").length },
      });
      return { title: data.title ?? "", content: data.content ?? "" };
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await sleep(300);
    }
  }
  throw new DeepSeekError(`fetch failed: ${String(lastErr)}`);
}
