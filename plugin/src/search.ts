/**
 * DeepSeek Search + Fetch behind Minimi's single `web_search` tool.
 *
 * The model never sees these HTTP endpoints. One tool call expands into a
 * bounded, concurrent batch of provider search requests, and (when the task
 * needs page text) one internal Fetch per query. Every attempt, including
 * retries, is reported to the caller's budget counter.
 */
import { config, assertSearchConfigured, debugLog } from './config.ts'

export interface RawSearchResult {
  title?: string
  url?: string
  snippet?: string
  summary?: string
  content?: string
  date?: string | null
  authority?: number | null
  rerank_score?: number | null
  site_name?: string | null
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
  summary: string
  date: string | null
  authority: number
  rerankScore: number
  siteName: string | null
}

export interface SearchResponse {
  results: SearchResult[]
  attempts: number
  fetched: number
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalise(r: RawSearchResult): SearchResult {
  return {
    title: (r.title ?? '').trim() || '(untitled)',
    url: (r.url ?? '').trim(),
    snippet: (r.snippet ?? '').trim(),
    summary: (r.summary ?? r.content ?? r.snippet ?? '').trim(),
    date: r.date ?? null,
    authority: typeof r.authority === 'number' ? r.authority : -1,
    rerankScore: typeof r.rerank_score === 'number' ? r.rerank_score : 0,
    siteName: r.site_name ?? null,
  }
}

/** Bounded-concurrency runner. The batch is at most three, but shortlist runs can grow. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

async function providerFetch(url: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const fused = AbortSignal.any([signal, timeout])
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: fused,
    redirect: 'error',
  })
}

async function loadFixture(query: string): Promise<SearchResult[] | null> {
  if (!config.fixtures) return null
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const file = path.join(config.fixtures, 'search.json')
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, RawSearchResult[]>
    // `"*"` is a deterministic fallback for model-paraphrased queries in tests.
    const rows = data[query.trim().toLowerCase()] ?? data[query.trim()] ?? data['*'] ?? null
    return rows ? rows.map(normalise).filter((r) => r.url) : []
  } catch {
    return []
  }
}

async function loadFetchFixture(url: string): Promise<{ title: string; content: string } | null> {
  if (!config.fixtures) return null
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  try {
    const data = JSON.parse(await fs.readFile(path.join(config.fixtures, 'fetch.json'), 'utf8')) as Record<string, { title: string; content: string }>
    return data[url] ?? data['*'] ?? null
  } catch {
    return null
  }
}

/**
 * One search query with up to three attempts. `onAttempt` is called before
 * every network attempt and may throw when the turn budget is exhausted.
 */
export async function webSearch(
  query: string,
  opts: {
    count?: number
    oriQuestion?: string
    signal: AbortSignal
    onAttempt: () => void
  },
): Promise<SearchResponse> {
  const q = query.trim().slice(0, 160)
  if (!q) return { results: [], attempts: 0, fetched: 0 }

  const fixture = await loadFixture(q)
  if (fixture) {
    opts.onAttempt()
    await sleep(10)
    return { results: fixture, attempts: 1, fetched: 0 }
  }
  assertSearchConfigured()

  const payload: Record<string, unknown> = {
    query: q,
    count: Math.min(50, Math.max(1, opts.count ?? config.maxResultsPerQuery)),
  }
  if (opts.oriQuestion) payload.ori_question = opts.oriQuestion.slice(0, 160)

  let lastErr: unknown
  let attempts = 0
  for (let i = 0; i < 3; i++) {
    attempts++
    opts.onAttempt()
    try {
      const res = await providerFetch(
        `${config.searchBaseUrl}/v1/tools/search`,
        payload,
        opts.signal,
        config.searchTimeoutMs,
      )
      if (RETRYABLE.has(res.status)) throw new Error(`transient HTTP ${res.status}`)
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`search HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      const data = (await res.json()) as { results?: RawSearchResult[] }
      const results = (data.results ?? []).map(normalise).filter((r) => r.url)
      debugLog('search', { query: q, results: results.length, attempts })
      return { results, attempts, fetched: 0 }
    } catch (err) {
      if (opts.signal.aborted) throw err
      if ((err as { code?: string })?.code === 'MINIMI_SEARCH_BUDGET') throw err
      lastErr = err
      if (i < 2) await sleep(350 * 2 ** i)
    }
  }
  throw new Error(`search failed after ${attempts} attempt(s): ${String(lastErr)}`)
}

/**
 * Internal Fetch. Not a model-callable tool: the single `web_search` tool owns
 * page retrieval and uses it to ground authoritative or stale sources.
 */
export async function fetchPage(
  url: string,
  opts: { signal: AbortSignal; onAttempt: () => void },
): Promise<{ title: string; content: string; attempts: number }> {
  assertSearchConfigured()
  const fixture = await loadFetchFixture(url)
  if (fixture) {
    opts.onAttempt()
    await sleep(5)
    return { title: fixture.title, content: fixture.content, attempts: 1 }
  }
  let lastErr: unknown
  let attempts = 0
  for (let i = 0; i < 2; i++) {
    attempts++
    opts.onAttempt()
    try {
      const res = await providerFetch(
        `${config.searchBaseUrl}/v1/tools/fetch`,
        { url },
        opts.signal,
        config.searchTimeoutMs,
      )
      if (RETRYABLE.has(res.status)) throw new Error(`transient HTTP ${res.status}`)
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`fetch HTTP ${res.status}: ${text.slice(0, 160)}`)
      }
      const data = (await res.json()) as { title?: string; content?: string }
      return { title: data.title ?? '', content: data.content ?? '', attempts }
    } catch (err) {
      if (opts.signal.aborted) throw err
      if ((err as { code?: string })?.code === 'MINIMI_SEARCH_BUDGET') throw err
      lastErr = err
      if (i === 0) await sleep(300)
    }
  }
  throw new Error(`fetch failed after ${attempts} attempt(s): ${String(lastErr)}`)
}

/** Merge a fetched page into the result set without duplicating the URL. */
export function mergeFetched(results: SearchResult[], fetched: { title: string; content: string }, url: string): SearchResult[] {
  const content = fetched.content.trim()
  if (!content) return results
  const existing = results.find((r) => r.url === url)
  if (existing) {
    existing.summary = `${content}\n${existing.summary}`.slice(0, 24000)
    existing.title = existing.title || fetched.title
    return results
  }
  return [
    {
      title: fetched.title || url,
      url,
      snippet: content.slice(0, 500),
      summary: content.slice(0, 24000),
      date: null,
      authority: 3,
      rerankScore: 0.1,
      siteName: null,
    },
    ...results,
  ]
}
