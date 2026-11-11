import "dotenv/config";
import path from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num("PORT", 8787),
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  model: process.env.DEEPSEEK_MODEL ?? "deepseek-flash",
  dbPath: path.resolve(process.env.MINIMI_DB ?? "./data/minimi.db"),
  defaultTz: process.env.MINIMI_DEFAULT_TZ ?? "auto",
  digestTokens: num("MINIMI_DIGEST_TOKENS", 900),
  parallelism: num("MINIMI_PARALLELISM", 6),
  debug: process.env.MINIMI_DEBUG === "1",
  /** Scripted backend: no network, no key. For demos, CI and eval mechanics. */
  offline: process.env.MINIMI_OFFLINE === "1",
  /** Pricing, USD per 1M tokens / per request. Idle tier; peak is 2x. */
  price: {
    inMiss: 0.14,
    inHit: 0.028,
    out: 0.56,
    perSearch: 0.00075,
    perFetch: 0.00075,
  },
} as const;

export function assertConfigured(): void {
  if (config.offline) return;
  if (!config.apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is not set. Copy .env.example to .env and add your key " +
        "(https://platform.deepseek.com/api_keys).",
    );
  }
}

export function logDebug(...args: unknown[]): void {
  if (config.debug) console.log("[minimi]", ...args);
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  modelCalls: number;
  /** Billable search requests (a request is billed only when it returns results). */
  searchRequests: number;
  /** Search calls attempted, billed or not. Equals the number of spans emitted. */
  searchAttempts: number;
  searchResults: number;
}

export function emptyUsage(): Usage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    modelCalls: 0,
    searchRequests: 0,
    searchAttempts: 0,
    searchResults: 0,
  };
}

export function addUsage(into: Usage, from: Usage): void {
  into.promptTokens += from.promptTokens;
  into.completionTokens += from.completionTokens;
  into.cacheHitTokens += from.cacheHitTokens;
  into.cacheMissTokens += from.cacheMissTokens;
  into.modelCalls += from.modelCalls;
  into.searchRequests += from.searchRequests;
  into.searchAttempts += from.searchAttempts;
  into.searchResults += from.searchResults;
}

export function costOf(u: Usage): number {
  return (
    (u.cacheMissTokens / 1e6) * config.price.inMiss +
    (u.cacheHitTokens / 1e6) * config.price.inHit +
    (u.completionTokens / 1e6) * config.price.out +
    u.searchRequests * config.price.perSearch
  );
}
