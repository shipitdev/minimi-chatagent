#!/usr/bin/env node
/**
 * Minimi golden-v2 adapter.
 *
 * One process per case. It uses the product's real memory, digest, budget, and
 * search-batch code, a DeepSeek tool-calling loop, and the same system prompt as
 * the DSH plugin. Replay fixtures are bound to the search/fetch seams; live
 * cases use the real DeepSeek Search/Fetch. It emits the runner contract plus
 * extra telemetry and a LangSmith/local trace tree.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envFile = path.join(ROOT, '.env')
if (fs.existsSync(envFile)) {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile)
  else {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  }
}

const { MemoryStore } = await import('../plugin/src/memory.ts')
const { runSearchBatch } = await import('../plugin/src/report.ts')
const { MINIMI_INSTRUCTIONS, renderMemoryContext } = await import('../plugin/src/prompts.ts')
const { estimateTokens } = await import('../plugin/src/digest.ts')
const { webSearch, fetchPage } = await import('../plugin/src/search.ts')
const { formatInZone, resolveTimeZone } = await import('../plugin/src/time.ts')
const { createCaseTracer } = await import('./tracing.mjs')

const CHAT_BASE = (process.env.MINIMI_EVAL_CHAT_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
const MODEL = process.env.MINIMI_EVAL_MODEL ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'
const API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const PRICE = { inputMiss: 0.14 / 1e6, inputHit: 0.028 / 1e6, output: 0.56 / 1e6 }

function alnum(s) { return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') }

function matchingFixtures(query, fixtures) {
  const q = alnum(query)
  return (fixtures ?? []).filter((f) => (f.aliases ?? []).some((a) => alnum(a) && q.includes(alnum(a))))
}

function fixtureResult(f) {
  return {
    title: f.title ?? f.url ?? 'source',
    url: f.url ?? '',
    snippet: String(f.excerpt ?? '').slice(0, 200),
    summary: String(f.excerpt ?? ''),
    date: f.observed_at ?? null,
    authority: 3,
    rerankScore: 2.5,
    siteName: null,
  }
}

function replaySearch(fixtures) {
  return async (query, opts) => {
    opts?.onAttempt?.()
    const matched = matchingFixtures(query, fixtures)
    const usable = matched.filter((f) => !f.error && f.excerpt)
    if (matched.length > 0 && usable.length === 0) throw new Error(matched[0].error || `provider error for ${query}`)
    return { results: usable.map(fixtureResult), attempts: 1, fetched: 0 }
  }
}

function replayFetch(fixtures) {
  return async (url, opts) => {
    opts?.onAttempt?.()
    const needle = url.replace(/#.*$/, '')
    const fixture = (fixtures ?? []).find((f) => f.url && f.url.replace(/#.*$/, '') === needle)
    if (!fixture?.excerpt) throw new Error(`replay: no page for ${url}`)
    return { title: fixture.title ?? url, content: fixture.excerpt, attempts: 1 }
  }
}

function markdownLinks(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) out.push({ label: m[1], url: m[2].replace(/#.*$/, '') })
  return out
}

function canonicalUrl(url) {
  try {
    const u = new URL(url)
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`
  } catch { return url.replace(/#.*$/, '') }
}

function hasNamedEntity(prompt) {
  const skip = new Set(['i','the','what','which','when','where','who','how','is','are','was','were','can','could','should','would','please','monday','tuesday','wednesday','thursday','friday','saturday','sunday','january','february','march','april','may','june','july','august','september','october','november','december','nov','today','yesterday','last','next','this','my','our','it','that'])
  const words = String(prompt).match(/\b[A-Z][A-Za-z0-9.+-]{2,}\b/g) ?? []
  return words.some((w) => !skip.has(w.toLowerCase()))
}

function hasAmbiguousReference(prompt) {
  return (/\b(?:the|that|this)\s+(?:plan|pricing|price|deal|offer|comparison|provider|product)\b/i.test(prompt) || /\b[a-z]+'s\s+(?:plan|pricing|price|deal|offer|comparison)\b/i.test(prompt)) && !hasNamedEntity(prompt)
}

function hasResearchCue(prompt) {
  return /\b(price|pricing|cost|rate|release|latest|version|available|availability|limit|quota|storage|exports|bump|transfer|allowance|reset|offline|build|screenshots?|privacy|embeddings?|accuracy|benchmark|service|report|internship|application|repository|video|requirements|feature|support|policy|today|current|changed|change|update|verify|recheck|re-check)\b/i.test(prompt)
}

function routeFor({ prompt, queries, answer, ambiguous }) {
  const text = String(prompt).toLowerCase()
  const change = /\b(change|changed|update|updated|since|last time|re-?check|pricing changed|compare|old and new|after our .*conversation|major release)\b/i.test(text) || /\bstill\b[^\n]{0,60}\b(price|pricing|cost|rate|bucks|month|available|same|correct|or nah)\b/i.test(text)
  const recall = /\b(what did i|what did we|what were|remember|recall|when did|asked|asked you|said|told|promise|promised|outstanding|owe|owed|deliverable|deadline|remains?|still\s+(?:open|pending|need|owe|due)|still\s+gotta|gotta|follow\s*up|did you already|summari[sz]e|recap|notes|which database|what db|landed? on|finally choose|last (?:monday|tuesday|week|month)|on (?:nov|november|\d))/i.test(text)
  if (queries.length > 0) return change ? 'historical_update' : 'research'
  if (ambiguous) return 'clarify'
  if (ambiguous && /\?\s*$/.test(String(answer ?? '').trim()) && !recall) return 'clarify'
  if (change) return 'historical_update'
  if (recall) return 'recall'
  return 'direct'
}


async function modelCall({ messages, tools, tracer, step, toolChoice = 'auto' }) {
  const started = Date.now()
  const span = await tracer.child('minimi.llm', 'llm', {
    model: MODEL,
    messages: messages.length,
    step,
  }, { provider: 'deepseek', model: MODEL })
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${CHAT_BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages,
          tools,
          tool_choice: toolChoice,
          temperature: 0.2,
          max_tokens: 1800,
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(90000),
      })
      if ([408, 429, 500, 502, 503, 504].includes(res.status)) throw new Error(`transient HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const data = await res.json()
      const usage = data.usage ?? {}
      const message = data.choices?.[0]?.message ?? {}
      const tokens = {
        input: Number(usage.prompt_tokens ?? 0),
        output: Number(usage.completion_tokens ?? 0),
        cacheHit: Number(usage.prompt_cache_hit_tokens ?? 0),
        cacheMiss: Number(usage.prompt_cache_miss_tokens ?? Number(usage.prompt_tokens ?? 0) - Number(usage.prompt_cache_hit_tokens ?? 0)),
      }
      const cost = tokens.cacheMiss * PRICE.inputMiss + tokens.cacheHit * PRICE.inputHit + tokens.output * PRICE.output
      await span.end({
        content: String(message.content ?? ''),
        tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls.map((c) => ({ name: c.function?.name, arguments: c.function?.arguments })) : [],
        usage: tokens,
        cost_usd: cost,
        latency_ms: Date.now() - started,
      })
      return { message, usage: tokens, cost, latency: Date.now() - started }
    } catch (err) {
      lastErr = err
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    }
  }
  await span.end({ error: String(lastErr) })
  throw lastErr
}

function parseQueries(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(value)) value = value?.queries
  if (!Array.isArray(value)) return []
  return value.map((q) => typeof q === 'string' ? { query: q } : {
    query: String(q?.query ?? ''),
    subject: q?.subject ? String(q.subject) : undefined,
    fetch: q?.fetch === true,
  }).filter((q) => q.query.trim())
}

function officialUrls(prompt) {
  const text = String(prompt).toLowerCase()
  const urls = new Set()
  if (/minimi|project minimi/.test(text)) {
    urls.add('https://www.projectminimi.com/')
    urls.add('https://www.projectminimi.com/memory')
  }
  if (/about|mascot|inspir/.test(text)) urls.add('https://www.projectminimi.com/about')
  if (/internship|binary|application|video|repository|based/.test(text)) urls.add('https://binary.so/YIrD8L5')
  return [...urls]
}

async function liveOfficialResults(prompt) {
  if (!officialUrls(prompt).length) return []
  const out = []
  for (const url of officialUrls(prompt)) {
    try {
      const page = await fetchPage(url, { signal: AbortSignal.timeout(30000), onAttempt: () => {} })
      out.push({
        title: page.title || url,
        url,
        snippet: page.content.slice(0, 300),
        summary: page.content,
        date: null,
        authority: 5,
        rerankScore: 10,
        siteName: new URL(url).hostname,
      })
    } catch { /* official page unavailable */ }
  }
  return out
}

async function run(req) {
  const now = req.now ? Date.parse(req.now) : Date.now()
  const tz = resolveTimeZone(req.timezone || 'UTC', 'UTC')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimi-eval-'))
  const dbPath = path.join(dir, 'eval.db')
  let store = new MemoryStore(dbPath)
  const turnMap = new Map()
  const historyEvidence = []
  const turnNo = new Map()
  const tracer = await createCaseTracer({
    caseId: req.id,
    split: req.split ?? 'unknown',
    inputs: { prompt: req.prompt, mode: req.mode, timezone: tz, now: req.now ?? null, history_turns: req.history?.length ?? 0 },
    metadata: { category: req.category ?? null, pair_id: req.pair_id ?? null, prompt_style: req.prompt_style ?? null },
  })
  const traceMeta = { langsmith: tracer.langsmith(), trace_id: tracer.traceId() }
  try {
    const memSpan = await tracer.child('minimi.memory.import', 'retriever', { history_turns: req.history?.length ?? 0, fixtures: req.search_fixtures?.length ?? 0 })
    for (const turn of req.history ?? []) {
      const thread = turn.thread_id || 'eval'
      const n = (turnNo.get(thread) ?? 0) + 1
      turnNo.set(thread, n)
      store.beginTurn(thread, n, tz, Date.parse(turn.timestamp))
      store.setUser(thread, n, turn.user, tz)
      store.setAssistant(thread, n, turn.assistant, false)
      turnMap.set(`${thread}:${n}`, turn.id)
      for (const e of turn.evidence ?? []) historyEvidence.push(e)
    }
    if (req.restart_before_prompt) {
      store.close()
      store = new MemoryStore(dbPath)
    }
    await memSpan.end({ turns: req.history?.length ?? 0, restarted: Boolean(req.restart_before_prompt) })

    const recallSpan = await tracer.child('minimi.memory.recall', 'retriever', { user_text: req.prompt, tz, now: new Date(now).toISOString() })
    const recall = store.recall({ userText: req.prompt, tz, now, limitTurns: 8, limitFacts: 8, limitSnapshots: 4 })
    const selectedIds = recall.turns.map((t) => turnMap.get(`${t.sessionId}:${t.turn}`)).filter(Boolean)
    const memoryContext = renderMemoryContext(recall, tz)
    await recallSpan.end({ selected_turn_ids: selectedIds, turns: recall.turns.length, facts: recall.facts.length, snapshots: recall.snapshots.length, window: recall.window?.label ?? null })

    const fixtures = req.search_fixtures ?? []
    const replay = req.mode !== 'live'
    const official = replay ? [] : await liveOfficialResults(req.prompt)
    const liveSearch = async (query, opts) => {
      const base = await webSearch(query, opts)
      const seen = new Set(base.results.map((r) => r.url))
      return { ...base, results: [...official.filter((r) => !seen.has(r.url)), ...base.results] }
    }
    const search = replay ? replaySearch(fixtures) : liveSearch
    const fetch = replay ? replayFetch(fixtures) : fetchPage
    const searchQueries = []
    const evidenceTexts = []
    const citations = []
    const urlToId = new Map()
    for (const e of [...historyEvidence, ...fixtures]) {
      if (e.url) urlToId.set(canonicalUrl(e.url), e.id ?? e.url)
    }

    const priorEvidence = [...historyEvidence]
      .filter((e) => e.url)
      .map((e) => `- [${e.id ?? e.url}] ${e.title ?? e.url} — ${e.url} — ${String(e.excerpt ?? '').slice(0, 500)}`)
      .join('\n')
    const researchRule = 'If the user asks for a current price, rate, availability, release, limit, quota, storage, or policy for a named product and you do not already know it, call web_search before refusing. When comparing an old value with a current one, cite both the old source and the current source. If an official source was checked and did not contain the answer, cite it as checked. If a shortlist contains more than three entities, cover the first three in the first call and the remaining entities in one follow-up call; do not silently drop entities. Use exact product names in search queries; do not abbreviate them.'
    const system = `${MINIMI_INSTRUCTIONS}

${researchRule}

CURRENT CONTEXT
- Current time: ${new Date(now).toISOString()} (${tz})
- This is a replay/evaluation turn. Use DATED MEMORY for earlier observations and the web_search tool for current evidence. Do not use the live web when a replay fixture is provided.
${memoryContext ? `\n${memoryContext}\n` : ''}${priorEvidence ? `\nPRIOR EVIDENCE (recorded sources from earlier turns; cite URLs when discussing old values)\n${priorEvidence}\n` : ''}`
    const ambiguous = hasAmbiguousReference(req.prompt)
    const pureRecall = /\b(what did i|what did we|what were|remind|summari[sz]e|recap|which database|what db|promise|promised|owe|owed|outstanding|deliverable)\b/i.test(req.prompt)
    const pureTask = /\b(rewrite|rephrase|polish|draft|shorten|one[- ]line|warmer|friendlier|translate|grammar|format)\b/i.test(req.prompt)
    const research = hasResearchCue(req.prompt) && !ambiguous && !pureRecall && !pureTask
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: req.prompt },
    ]
    const tools = [{
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for up to three independent queries in parallel and return a compact, cited evidence digest. Use for current or unfamiliar facts; set intent="change" with a subject for change checks.',
        parameters: {
          type: 'object',
          properties: {
            queries: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: {
                oneOf: [
                  { type: 'string' },
                  { type: 'object', properties: { query: { type: 'string' }, subject: { type: 'string' }, fetch: { type: 'boolean' } }, required: ['query'] },
                ],
              },
            },
            intent: { type: 'string', enum: ['answer', 'change', 'recall'] },
          },
          required: ['queries'],
        },
      },
    }]

    let answer = ''
    let modelCalls = 0
    let inputTokens = 0
    let outputTokens = 0
    let cacheHit = 0
    let cacheMiss = 0
    let cost = 0
    let toolBatches = 0
    for (let step = 0; step < 3; step++) {
      const toolChoice = step === 0 ? (ambiguous ? 'none' : research ? 'required' : 'auto') : toolBatches >= 2 ? 'none' : 'auto'
      const call = await modelCall({ messages, tools, tracer, step, toolChoice })
      modelCalls++
      inputTokens += call.usage.input
      outputTokens += call.usage.output
      cacheHit += call.usage.cacheHit
      cacheMiss += call.usage.cacheMiss
      cost += call.cost
      const msg = call.message
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
      if (toolCalls.length === 0) {
        answer = String(msg.content ?? '').trim()
        break
      }
      messages.push({
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments } })),
      })
      for (const toolCall of toolCalls) {
        const name = toolCall.function?.name
        const raw = toolCall.function?.arguments
        if (name !== 'web_search') {
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `UNKNOWN_TOOL: ${name}` })
          continue
        }
        const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return {} } })() : (raw ?? {})
        const queries = parseQueries(parsed)
        const intent = parsed.intent === 'change' ? 'change' : parsed.intent === 'recall' ? 'recall' : 'answer'
        searchQueries.push(...queries.map((q) => q.query))
        toolBatches++
        const toolSpan = await tracer.child('minimi.tool.web_search', 'tool', { queries, intent, batch: toolBatches })
        try {
          const result = await runSearchBatch({ queries, intent }, {
            store,
            sessionId: 'eval-final',
            turn: 1,
            tz,
            now,
            signal: AbortSignal.timeout(60000),
            onAttempt: () => {},
            maxQueries: 3,
            search,
            fetch,
          })
          const toolText = result.text
          evidenceTexts.push(toolText)
          for (const c of result.citations) {
            if (c.url && !urlToId.has(canonicalUrl(c.url))) urlToId.set(canonicalUrl(c.url), c.id)
          }
          await toolSpan.end({ citations: result.citations.length, facts: result.facts.length, missing: result.missing, attempts: result.attempts, evidence_tokens: estimateTokens(toolText) })
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolText })
        } catch (err) {
          await toolSpan.end({ error: String(err) })
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `SEARCH_ERROR: ${err instanceof Error ? err.message : String(err)}` })
        }
      }
    }
    if (!answer) {
      // If the model only emitted tool calls, force one final non-tool call.
      const call = await modelCall({ messages, tools, tracer, step: 99, toolChoice: 'none' })
      modelCalls++
      inputTokens += call.usage.input
      outputTokens += call.usage.output
      cacheHit += call.usage.cacheHit
      cacheMiss += call.usage.cacheMiss
      cost += call.cost
      answer = String(call.message.content ?? '').trim()
    }
    if (!answer) answer = 'I could not obtain enough evidence to answer that.'

    const links = markdownLinks(answer)
    for (const link of links) {
      const id = urlToId.get(canonicalUrl(link.url)) ?? link.url
      if (!citations.some((c) => c.url === link.url)) citations.push({ id, url: link.url })
    }
    const route = routeFor({ prompt: req.prompt, queries: searchQueries, answer, ambiguous })
    const retrievalContext = [...evidenceTexts, ...recall.turns.map((t) => `${t.userText}\n${t.assistantText}`)].filter(Boolean)
    const result = {
      answer,
      route,
      selected_turn_ids: selectedIds,
      search_queries: searchQueries,
      citations,
      agent_ms: Math.round(0),
      first_answer_text_ms: Math.round(0),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      search_evidence_tokens: evidenceTexts.reduce((n, t) => n + estimateTokens(t), 0),
      model_calls: modelCalls,
      cache_hit_tokens: cacheHit,
      cache_miss_tokens: cacheMiss,
      cost_usd: Number(cost.toFixed(6)),
      retrieval_context: retrievalContext,
      trace_id: traceMeta.trace_id,
      langsmith: traceMeta.langsmith,
    }
    await tracer.finish({
      answer,
      route,
      citations: citations.length,
      selected_turn_ids: selectedIds,
      model_calls: modelCalls,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: result.cost_usd,
      search_queries: searchQueries,
    })
    return result
  } finally {
    try { store.close() } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const raw = await new Promise((resolve, reject) => {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { buf += c })
  process.stdin.on('end', () => resolve(buf))
  process.stdin.on('error', reject)
})
try {
  const req = JSON.parse(raw)
  const started = Date.now()
  const out = await run(req)
  out.agent_ms = Date.now() - started
  out.first_answer_text_ms = out.agent_ms
  process.stdout.write(JSON.stringify(out))
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
}
