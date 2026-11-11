/**
 * One `web_search` batch → compact, cited evidence and deterministic change view.
 *
 * Raw provider prose never leaves this module: the model sees claim-sized
 * clauses, source identities, and (for change checks) a host-computed diff
 * against the saved baseline.
 */
import { buildDigest, diffFacts, type Fact } from './digest.ts'
import { comparePriceTerms, formatTerm, parsePriceTerms } from './billing.ts'
import { config, debugLog } from './config.ts'
import { fetchPage, mapLimit, mergeFetched, webSearch, type SearchResponse, type SearchResult } from './search.ts'
import { formatInZone, resolveTimeZone } from './time.ts'
import {
  MemoryStore,
  subjectKey,
  type MemoryCitation,
  type SnapshotRecord,
  type StoredFact,
} from './memory.ts'

export type SearchIntent = 'answer' | 'change' | 'recall'

export interface QueryItem {
  query: string
  subject?: string
  fetch?: boolean
}

export interface SearchBatchInput {
  queries: QueryItem[]
  intent: SearchIntent
}

export type SearchSeam = (query: string, opts: { count?: number; oriQuestion?: string; signal: AbortSignal; onAttempt: () => void }) => Promise<SearchResponse>
export type FetchSeam = (url: string, opts: { signal: AbortSignal; onAttempt: () => void }) => Promise<{ title: string; content: string; attempts: number }>

export interface SearchBatchDeps {
  store: MemoryStore
  sessionId: string
  turn: number
  tz: string
  now: number
  signal: AbortSignal
  onAttempt: () => void
  maxQueries: number
  /** Optional seams used by the golden replay adapter; production defaults to the live provider. */
  search?: SearchSeam
  fetch?: FetchSeam
}

export interface SearchBatchResult {
  text: string
  citations: MemoryCitation[]
  facts: StoredFact[]
  missing: string[]
  attempts: number
  fetched: number
  truncated: boolean
}

interface ItemOutcome {
  item: QueryItem
  ok: boolean
  error?: string
  results: SearchResult[]
  fetched: boolean
  digestBlock: string
  citations: MemoryCitation[]
  facts: StoredFact[]
  missing: string[]
  digestStats: { kept: number; dropped: number; ratio: number; inputTokens: number; digestTokens: number; budgetExhausted: boolean }
  attempts: number
  prior: SnapshotRecord | null
}

const CITATION_RE = /\[(\d+)\]/g

function digestSubjectFor(subject: string | undefined): string | undefined {
  const value = subject?.trim()
  if (!value) return undefined
  // A model often supplies a full phrase ("TernDB Launch plan price") rather
  // than the entity itself. Keep the entity prefix so subject gating does not
  // discard the very clause that carries the value.
  return value.replace(/\s+(?:launch|pricing|price|cost|plan|tier|subscription|export|exports|limit|quota|storage|allowance|transfer|offline|build|time|feature|support|availability|release|version)(?:\s+.*)?$/i, '').trim() || value
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return 'unknown' }
}

function shouldFetch(item: QueryItem, intent: SearchIntent, results: SearchResult[]): SearchResult | null {
  const top = [...results].sort((a, b) => b.rerankScore - a.rerankScore || b.authority - a.authority)[0]
  if (!top) return null
  if (!/^https?:\/\//i.test(top.url)) return null
  if (item.fetch) return top
  if (intent === 'change') return top
  // A thin snippet is where a fetch materially improves the evidence; a long
  // summary already gives the digester enough to select claims.
  if (top.summary.trim().length < 420 && top.authority >= 2) return top
  return null
}

function qualifiersFor(entity: string, attribute: string, evidence: string): string[] {
  if (attribute !== 'price' && attribute !== 'cost') return []
  const terms = parsePriceTerms(evidence, entity).map(formatTerm)
  return [...new Set(terms)].slice(0, 3)
}

function toFact(f: Fact, cites: MemoryCitation[], retrievedAt: string): StoredFact {
  const cit = cites.find((c) => Number(c.id.replace(/\D/g, '')) === f.citationId)
  return {
    entity: f.entity,
    attribute: f.attribute,
    value: f.value,
    kind: f.kind,
    citationId: cit?.id ?? `S${f.citationId}`,
    url: cit?.url ?? '',
    title: cit?.title ?? '',
    publishedAt: cit?.publishedAt ?? null,
    retrievedAt,
    qualifiers: qualifiersFor(f.entity, f.attribute, f.evidence),
    evidence: f.evidence,
  }
}

function toDiffFact(f: StoredFact): Fact {
  return {
    entity: f.entity,
    attribute: f.attribute,
    value: f.value,
    kind: f.kind as Fact['kind'],
    citationId: Number(f.citationId.replace(/\D/g, '')) || 0,
    evidence: f.evidence,
    observedAt: f.retrievedAt,
  }
}

function renderChangeView(prior: SnapshotRecord, fresh: StoredFact[], tz: string): string {
  const priorFacts = prior.facts.map(toDiffFact)
  const freshFacts = fresh.map(toDiffFact)
  const changes = diffFacts(priorFacts, freshFacts)
  const lines: string[] = []
  const when = formatInZone(prior.updatedAt, prior.tz || tz)
  lines.push(`SAVED BASELINE (${prior.subject}) — snapshot updated ${when}`)
  for (const f of prior.facts) lines.push(`- Saved ${f.entity} | ${f.attribute}: ${f.value} | observed ${f.retrievedAt} | [saved source](${f.url})`)
  if (fresh.length === 0) {
    lines.push(`- The fresh evidence did not establish a value for ${prior.subject}. The saved baseline is retained; no change can be claimed.`)
    return lines.join('\n')
  }

  let shown = 0
  for (const c of changes) {
    if (c.kind === 'unchanged' && c.attribute !== 'price' && c.attribute !== 'cost') continue
    const freshFact = c.to ? fresh.find((f) => f.entity === c.to!.entity && f.attribute === c.to!.attribute && f.value === c.to!.value && f.evidence === c.to!.evidence) : undefined
    const priorFact = c.from ? prior.facts.find((f) => f.entity === c.from!.entity && f.attribute === c.from!.attribute && f.value === c.from!.value && f.evidence === c.from!.evidence) : undefined
    if (!freshFact) {
      lines.push(`- ${c.entity} | ${c.attribute}: no fresh value in this batch; not evidence of change. Baseline "${priorFact?.value ?? c.from?.value ?? 'unknown'}" retained.`)
      shown++
      continue
    }
    const cite = `[${freshFact.citationId}](${freshFact.url})`
    if (c.kind === 'new') {
      lines.push(`- ${c.entity} | ${c.attribute}: first observed "${freshFact.value}" ${cite} (no prior value, so not a change).`)
      shown++
      continue
    }
    if (c.attribute === 'price' || c.attribute === 'cost') {
      const oldTerm = parsePriceTerms(priorFact?.evidence ?? '', c.entity)[0] ?? null
      const newTerm = parsePriceTerms(freshFact.evidence ?? '', c.entity)[0] ?? null
      const cmp = comparePriceTerms(oldTerm, newTerm)
      if (cmp.status === 'unchanged') continue
      if (cmp.status === 'incomparable') {
        lines.push(`- ${c.entity} | ${c.attribute}: CANNOT ESTABLISH A CHANGE — ${cmp.reason}. Saved: ${formatTerm(oldTerm)}. Fresh: ${formatTerm(newTerm)} ${cite}.`)
      } else {
        const delta = cmp.deltaMonthly != null ? ` (${cmp.deltaMonthly >= 0 ? '+' : ''}$${Math.abs(cmp.deltaMonthly)}/mo equivalent)` : ''
        lines.push(`- ${c.entity} | ${c.attribute}: ${formatTerm(oldTerm)} -> ${formatTerm(newTerm)} ${cite} [${c.kind}${delta}]`)
      }
      shown++
      continue
    }
    lines.push(`- ${c.entity} | ${c.attribute}: "${c.from?.value ?? 'none'}" -> "${freshFact.value}" ${cite} [${c.kind}]`)
    shown++
  }
  if (shown === 0) {
    lines.push(`- The fresh evidence covers the same attributes with the same values as the saved baseline. No change detected.`)
  }
  lines.push(`Use only these rows for a "what changed" answer. Cite fresh values with the shown S ids; do not invent a delta.`)
  return lines.join('\n')
}

export async function runSearchBatch(input: SearchBatchInput, deps: SearchBatchDeps): Promise<SearchBatchResult> {
  const tz = resolveTimeZone(deps.tz, 'UTC')
  const items = input.queries
    .map((q) => ({ query: q.query.trim(), subject: q.subject?.trim() || undefined, fetch: q.fetch }))
    .filter((q) => q.query.length > 0)
    .slice(0, Math.min(deps.maxQueries, config.maxQueriesPerCall))

  const missing: string[] = []
  if (items.length === 0) {
    return { text: 'SEARCH_BATCH_EMPTY: no non-empty query was supplied.', citations: [], facts: [], missing: ['empty query'], attempts: 0, fetched: 0, truncated: false }
  }

  const perQueryBudget = Math.max(32, Math.floor(config.digestTokens / Math.max(1, items.length)))
  let fetchedCount = 0
  const retrievedAt = new Date(deps.now).toISOString()
  const searchFn = deps.search ?? webSearch
  const fetchFn = deps.fetch ?? fetchPage

  const outcomes: ItemOutcome[] = await mapLimit(items, config.concurrency, async (item) => {
    const prior = item.subject ? deps.store.getSnapshot(item.subject) : null
    const digestSubject = digestSubjectFor(item.subject)
    let itemAttempts = 0
    const onAttempt = () => { deps.onAttempt(); itemAttempts++ }
    try {
      const search = await searchFn(item.query, {
        count: config.maxResultsPerQuery,
        oriQuestion: item.query,
        signal: deps.signal,
        onAttempt,
      })
      let results = search.results
      let fetched = false
      const fetchTarget = shouldFetch(item, input.intent, results)
      if (fetchTarget && fetchedCount < items.length) {
        fetchedCount++
        try {
          const page = await fetchFn(fetchTarget.url, { signal: deps.signal, onAttempt })
          results = mergeFetched(results, page, fetchTarget.url)
          fetched = true
        } catch (err) {
          debugLog('internal fetch failed', fetchTarget.url, String(err))
        }
      }
      const digest = buildDigest({
        question: item.query,
        results,
        budgetTokens: perQueryBudget,
        intent: input.intent === 'recall' ? 'recall' : input.intent,
        subject: digestSubject,
        requireSubject: Boolean(digestSubject),
        priorFacts: prior?.facts.map((f) => ({ attribute: f.attribute, value: f.value })) ?? [],
      })
      return {
        item,
        ok: true,
        results,
        fetched,
        digestBlock: digest.block,
        citations: digest.citations.map((c) => ({
          id: `S${c.id}`,
          title: c.title,
          url: c.url,
          domain: c.domain,
          publishedAt: c.date,
          retrievedAt,
          authority: c.authority,
        })),
        facts: digest.facts.map((f) => toFact(f, digest.citations.map((c) => ({
          id: `S${c.id}`, title: c.title, url: c.url, domain: c.domain,
          publishedAt: c.date, retrievedAt, authority: c.authority,
        })), retrievedAt)),
        missing: [],
        digestStats: {
          kept: digest.stats.sentencesKept,
          dropped: digest.stats.sentencesDropped,
          ratio: digest.stats.ratio,
          inputTokens: digest.stats.inputTokens,
          digestTokens: digest.stats.digestTokens,
          budgetExhausted: digest.stats.budgetExhausted,
        },
        attempts: itemAttempts,
        prior,
      } satisfies ItemOutcome
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        item,
        ok: false,
        error: message,
        results: [],
        fetched: false,
        digestBlock: `(search failed: ${message})`,
        citations: [],
        facts: [],
        missing: [`search failed for "${item.query}": ${message}`],
        digestStats: { kept: 0, dropped: 0, ratio: 0, inputTokens: 0, digestTokens: 0, budgetExhausted: false },
        attempts: itemAttempts,
        prior,
      } satisfies ItemOutcome
    }
  })

  // Source IDs are batch-local; the URL and retrieval date identify the observation.
  const allCitations: MemoryCitation[] = []
  const allFacts: StoredFact[] = []
  const blocks: string[] = []
  let truncated = false

  for (const outcome of outcomes) {
    const localToGlobal = new Map<number, string>()
    for (const c of outcome.citations) {
      const local = Number(c.id.replace(/\D/g, ''))
      const globalId = `S${allCitations.length + 1}`
      localToGlobal.set(local, globalId)
      allCitations.push({ ...c, id: globalId })
    }
    let remapped = outcome.digestBlock.replace(CITATION_RE, (_m, n: string) => `[${localToGlobal.get(Number(n)) ?? n}]`)
    // Put the URL inside every citation marker, so every evidence line is itself
    // a copyable Markdown link. Small models copy ready-made syntax far more
    // reliably than they translate a separate source ledger.
    for (const c of outcome.citations) {
      const globalId = localToGlobal.get(Number(c.id.replace(/\D/g, ''))) ?? c.id
      remapped = remapped.split(`[${globalId}]`).join(`[${globalId}](${c.url})`)
    }
    const remappedFacts = outcome.facts.map((f) => ({
      ...f,
      citationId: localToGlobal.get(Number(f.citationId.replace(/\D/g, ''))) ?? f.citationId,
    }))
    allFacts.push(...remappedFacts)
    outcome.citations = outcome.citations.map((c) => ({ ...c, id: localToGlobal.get(Number(c.id.replace(/\D/g, ''))) ?? c.id }))
    outcome.digestBlock = remapped
    outcome.facts = remappedFacts

    if (outcome.digestStats.digestTokens > 0 && outcome.digestStats.kept === 0) {
      outcome.missing.push(`no usable claim-sized evidence for "${outcome.item.query}"`)
    }
    const expectedSubject = digestSubjectFor(outcome.item.subject)
    if (expectedSubject && !outcome.facts.some((f) => f.entity.toLowerCase() === expectedSubject.toLowerCase())) {
      outcome.missing.push(`no value found that is tied to subject "${outcome.item.subject}"`)
    }
    if (outcome.digestBlock.includes('(no usable evidence was retrieved)') || outcome.digestBlock.includes('(search failed:')) {
      outcome.missing.push(`evidence gap for "${outcome.item.query}"`)
    }
    missing.push(...outcome.missing)

    const header = [
      `=== QUERY ${blocks.length + 1}/${outcomes.length} ===`,
      `query: "${outcome.item.query}"`,
      outcome.item.subject ? `subject: ${outcome.item.subject}` : null,
      outcome.fetched ? `internal_fetch: yes` : null,
      outcome.ok ? null : `ERROR: ${outcome.error}`,
    ].filter(Boolean).join('\n')

    const citedIds = new Set<number>()
    for (const f of outcome.facts) citedIds.add(Number(f.citationId.replace(/\D/g, '')))
    const sourceLines = outcome.citations
      .filter((c) => citedIds.size === 0 || citedIds.has(Number(c.id.replace(/\D/g, ''))))
      .map((c) => {
        const pub = c.publishedAt ? ` published=${c.publishedAt.slice(0, 10)}` : ''
        return `- [${c.id}](${c.url}) — ${c.title}${pub} retrieved=${c.retrievedAt}`
      })
    const evidence = outcome.ok
      ? `EVIDENCE\n${outcome.digestBlock}`
      : `EVIDENCE\n(no usable evidence: ${outcome.error})`
    const sources = sourceLines.length > 0 ? `\nSOURCES (for citation)\n${sourceLines.join('\n')}` : ''
    const miss = outcome.missing.length > 0 ? `\nMISSING\n- ${outcome.missing.join('\n- ')}` : ''
    blocks.push(`${header}\n${evidence}${sources}${miss}`)
  }

  truncated = outcomes.some((o) => o.digestStats.budgetExhausted)

  // Deterministic change checks happen after evidence is normalized.
  const changeBlocks: string[] = []
  for (const outcome of outcomes) {
    if (input.intent !== 'change' || !outcome.item.subject) continue
    const subject = outcome.item.subject
    const prior = outcome.prior
    if (!prior) {
      changeBlocks.push(`SAVED BASELINE (${subject}) — none. This batch records the first observation; there is no prior value to compare.`)
      continue
    }
    changeBlocks.push(renderChangeView(prior, outcome.facts, tz))
  }

  const totalAttempts = outcomes.reduce((n, o) => n + o.attempts, 0)
  const copyable = allCitations.map((c) => `[${c.id}](${c.url})`).join('\n')
  const text = [
    'MINIMI_SEARCH_BATCH',
    `intent=${input.intent} queries=${outcomes.length} sources=${allCitations.length} fetched=${outcomes.filter((o) => o.fetched).length} attempts=${totalAttempts}`,
    '',
    ...blocks,
    changeBlocks.length > 0 ? `\n=== CHANGE CHECK ===\n${changeBlocks.join('\n\n')}` : '',
    '',
    'CITATION RULES',
    '- Inline citations MUST be markdown links copied from the list below, e.g. [S3](https://example.com/page). Bare "S3" text is not clickable.',
    '- End with a **Sources** section whose entries are also markdown links. List only sources actually cited.',
    '- Use only the S ids above. Do not invent or alter a URL.',
    '- If an item is marked MISSING, answer the supported portion and say what is missing.',
    '- Do not claim a change when the change view says it cannot be established.',
    '',
    'COPYABLE SOURCE LINKS',
    copyable || '(none)',
    truncated ? '- Evidence was truncated to the digest budget; treat omissions as unknown, not absent.' : '',
  ].filter((l) => l !== null).join('\n')

  deps.store.recordSearch(deps.sessionId, deps.turn, input.intent, items, text, allCitations, totalAttempts, deps.now)
  deps.store.recordFacts(deps.sessionId, deps.turn, allFacts, deps.now)

  // Save the fresh baseline for each subject that produced at least one fact.
  for (const outcome of outcomes) {
    if (!outcome.item.subject || outcome.facts.length === 0) continue
    const refreshedKeys = new Set(outcome.facts.map((f) => `${f.entity.toLowerCase()}::${f.attribute.toLowerCase()}`))
    const retained = outcome.prior?.facts.filter((f) => !refreshedKeys.has(`${f.entity.toLowerCase()}::${f.attribute.toLowerCase()}`)) ?? []
    const retainedUrls = new Set(retained.map((f) => f.url))
    deps.store.saveSnapshot({
      subject: outcome.item.subject,
      subjectKey: subjectKey(outcome.item.subject),
      facts: [...outcome.facts, ...retained],
      citations: [...outcome.citations, ...(outcome.prior?.citations.filter((c) => retainedUrls.has(c.url)) ?? [])],
      updatedAt: deps.now,
      tz,
      sessionId: deps.sessionId,
    })
  }

  return {
    text,
    citations: allCitations,
    facts: allFacts,
    missing,
    attempts: totalAttempts,
    fetched: outcomes.filter((o) => o.fetched).length,
    truncated,
  }
}
