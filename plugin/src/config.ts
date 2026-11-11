import path from 'node:path'

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export const config = {
  /** DeepSeek Search/Fetch REST root. Chat traffic stays on the DSH adapter. */
  searchBaseUrl: (process.env.MINIMI_SEARCH_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  dbPath: path.resolve(process.env.MINIMI_DB ?? './data/minimi.db'),
  defaultTz: process.env.MINIMI_DEFAULT_TZ ?? 'auto',
  digestTokens: num('MINIMI_DIGEST_TOKENS', 900),
  concurrency: Math.max(1, num('MINIMI_SEARCH_CONCURRENCY', 3)),
  maxQueriesPerCall: Math.max(1, Math.min(3, num('MINIMI_MAX_QUERIES_PER_CALL', 3))),
  maxCallsPerTurn: Math.max(1, num('MINIMI_MAX_CALLS_PER_TURN', 2)),
  maxProviderAttemptsPerTurn: Math.max(1, num('MINIMI_MAX_PROVIDER_ATTEMPTS_PER_TURN', 12)),
  maxResultsPerQuery: Math.max(1, Math.min(20, num('MINIMI_MAX_RESULTS_PER_QUERY', 8))),
  searchTimeoutMs: num('MINIMI_SEARCH_TIMEOUT_MS', 25000),
  debug: process.env.MINIMI_DEBUG === '1',
  /** Read-only fixture directory for deterministic tests: a JSON map query -> results. */
  fixtures: process.env.MINIMI_SEARCH_FIXTURES ?? '',
}

export function assertSearchConfigured(): void {
  if (config.fixtures) return
  if (!config.apiKey) {
    throw new Error(
      'DEEPSEEK_API_KEY is not set. Copy .env.example to .env and add a key from https://platform.deepseek.com/api_keys.',
    )
  }
}

export function debugLog(...args: unknown[]): void {
  if (config.debug) console.log('[minimi]', ...args)
}
