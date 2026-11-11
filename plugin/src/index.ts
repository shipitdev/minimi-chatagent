/**
 * Minimi host plugin for DeepSeek Harness.
 *
 * One model-callable tool, owned here: `web_search`. Behind it live DeepSeek
 * Search + Fetch, parallel execution, the action-preserving digest, citations,
 * SQLite dated memory, and shortlist baselines. DSH owns the loop, sessions,
 * model calls, and the web UI.
 */
import fs from 'node:fs'
import path from 'node:path'
import { config, debugLog, assertSearchConfigured } from './config.ts'
import { MemoryStore, keywords, type MemoryCitation } from './memory.ts'
import { runSearchBatch, type QueryItem, type SearchIntent } from './report.ts'
import { MINIMI_INSTRUCTIONS, renderMemoryContext } from './prompts.ts'
import { isValidTimeZone, resolveTimeZone } from './time.ts'
import { Observability } from './observability.ts'

export const name = 'minimi'
export const inject = ['tools', 'systemPrompt', 'agents']

interface Budget {
  turn: number
  calls: number
  queries: number
  attempts: number
  changeUsed: boolean
  startedAt: number
}

class BudgetExceeded extends Error {
  readonly code = 'MINIMI_SEARCH_BUDGET'
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => Boolean(b) && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  return textOf((message as { content?: unknown }).content)
}

function sourceTz(message: unknown, fallback: string): string {
  if (!message || typeof message !== 'object') return fallback
  const source = (message as { source?: Record<string, unknown> }).source
  const tz = source?.clientTimeZone
  if (typeof tz === 'string' && isValidTimeZone(tz)) return tz
  return fallback
}

function normaliseQueries(raw: unknown): QueryItem[] {
  if (!Array.isArray(raw)) return []
  const out: QueryItem[] = []
  for (const q of raw.slice(0, 4)) {
    if (typeof q === 'string') {
      if (q.trim()) out.push({ query: q.trim() })
      continue
    }
    if (q && typeof q === 'object') {
      const o = q as Record<string, unknown>
      const query = typeof o.query === 'string' ? o.query.trim() : ''
      if (!query) continue
      out.push({
        query,
        subject: typeof o.subject === 'string' && o.subject.trim() ? o.subject.trim() : undefined,
        fetch: o.fetch === true,
      })
    }
  }
  return out
}

export function apply(ctx: any): void {
  const store = new MemoryStore()
  const obs = new Observability()
  const budgets = new Map<string, Budget>()
  const tzBySession = new Map<string, string>()
  const latestUserBySession = new Map<string, string>()
  let latestSessionId: string | null = null

  const fallbackTz = config.defaultTz === 'auto'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    : resolveTimeZone(config.defaultTz, 'UTC')

  ctx.effect(() => () => store.close())

  function tzFor(sessionId: string): string {
    return resolveTimeZone(tzBySession.get(sessionId) ?? fallbackTz, 'UTC')
  }

  function budgetFor(sessionId: string, turn: number): Budget {
    const existing = budgets.get(sessionId)
    if (existing && existing.turn === turn) return existing
    const fresh: Budget = { turn, calls: 0, queries: 0, attempts: 0, changeUsed: false, startedAt: Date.now() }
    budgets.set(sessionId, fresh)
    return fresh
  }

  function writeDebug(name: string, value: unknown): void {
    try {
      fs.mkdirSync(path.resolve('data'), { recursive: true })
      fs.writeFileSync(path.resolve('data', name), typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    } catch { /* debug output must never break a turn */ }
  }

  // ── the one tool ──────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'web_search',
    description:
      'Search the current web for up to three independent queries in parallel and return a compact, cited evidence digest. ' +
      'Use for current or unfamiliar facts. For a change check, set intent="change" and give each query a subject; the tool ' +
      'compares fresh evidence with the saved baseline and reports only defensible changes. At most two calls per turn; the ' +
      'second is for one targeted evidence gap. Do not use for ordinary conversation, dated recall from memory, or arithmetic.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        queries: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          description: 'Independent lookups to run concurrently. Put different subjects in the same batch.',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['query'],
                properties: {
                  query: { type: 'string', description: 'Search query, scoped to one subject when possible.' },
                  subject: { type: 'string', description: 'The entity this query is evidence for (needed for change checks).' },
                  fetch: { type: 'boolean', description: 'Ask the tool to retrieve the top source page internally.' },
                },
              },
            ],
          },
        },
        intent: {
          type: 'string',
          enum: ['answer', 'change', 'recall'],
          default: 'answer',
          description: 'answer = explain; change = compare with the saved baseline; recall = prior-observation support.',
        },
      },
      required: ['queries'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'citations', 'facts', 'missing', 'attempts', 'fetched', 'truncated'],
        properties: {
          text: { type: 'string' },
          citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
          facts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          missing: { type: 'array', items: { type: 'string' } },
          attempts: { type: 'number' },
          fetched: { type: 'number' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    isConcurrencySafe: () => false,
    async execute(args: any, exec: any) {
      const agent = exec.agent
      if (!agent) {
        return { text: 'SEARCH_UNAVAILABLE: this tool must run inside an agent turn.', citations: [], facts: [], missing: ['no agent context'], attempts: 0, fetched: 0, truncated: false }
      }
      const sessionId: string = agent.session.header.id
      const turn = ctx.agents.turnBoundaryOf(agent.session).lastTurn
      const intent: SearchIntent = args?.intent === 'change' ? 'change' : args?.intent === 'recall' ? 'recall' : 'answer'
      const queries = normaliseQueries(args?.queries)
      const budget = budgetFor(sessionId, turn)

      if (queries.length === 0) {
        return { text: 'SEARCH_INPUT_ERROR: provide 1–3 non-empty queries.', citations: [], facts: [], missing: ['no queries'], attempts: 0, fetched: 0, truncated: false }
      }
      if (budget.calls >= config.maxCallsPerTurn) {
        return {
          text: `SEARCH_BUDGET_EXCEEDED: this turn already used ${budget.calls} web_search call(s) (limit ${config.maxCallsPerTurn}). Answer from the evidence already returned and state any remaining gap.`,
          citations: [], facts: [], missing: ['search call budget exhausted'], attempts: budget.attempts, fetched: 0, truncated: true,
        }
      }
      if (intent === 'change' && budget.changeUsed) {
        return {
          text: 'CHANGE_ALREADY_CHECKED: this turn already has a deterministic CHANGE CHECK. Use that comparison; do not run a second baseline read. If it reported no change, say no change. If it reported a gap, say what is missing.',
          citations: [], facts: [], missing: ['change check already completed this turn'], attempts: budget.attempts, fetched: 0, truncated: false,
        }
      }

      assertSearchConfigured()
      const toolStarted = Date.now()
      budget.calls++
      if (intent === 'change') budget.changeUsed = true
      budget.queries += queries.length

      try {
        const result = await runSearchBatch(
          { queries, intent },
          {
            store,
            sessionId,
            turn,
            tz: tzFor(sessionId),
            now: Date.now(),
            signal: exec.signal,
            maxQueries: config.maxQueriesPerCall,
            onAttempt: () => {
              if (budget.attempts >= config.maxProviderAttemptsPerTurn) {
                throw new BudgetExceeded(
                  `provider attempt budget exhausted (${budget.attempts}/${config.maxProviderAttemptsPerTurn}); return the evidence already gathered and name the gap`,
                )
              }
              budget.attempts++
            },
          },
        )
        const footer = `\n\nBUDGET: call ${budget.calls}/${config.maxCallsPerTurn}, queries ${budget.queries}, provider attempts ${budget.attempts}/${config.maxProviderAttemptsPerTurn}.`
        debugLog('web_search', { sessionId, turn, intent, queries: queries.length, citations: result.citations.length, attempts: result.attempts })
        obs.tool(sessionId, turn, { queries: queries.map((q) => q.query), attempts: result.attempts, citations: result.citations.length, durationMs: Date.now() - toolStarted })
        return { ...result, text: result.text + footer }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        obs.tool(sessionId, turn, { queries: queries.map((q) => q.query), attempts: budget.attempts, citations: 0, durationMs: Date.now() - toolStarted, error: message })
        return {
          text: `SEARCH_BUDGET_EXCEEDED: ${message}. Use the evidence already returned; do not guess beyond it.`,
          citations: [], facts: [], missing: [message], attempts: budget.attempts, fetched: 0, truncated: true,
        }
      }
    },
  })

  // ── stable instructions + dynamic dated memory ───────────────────────────
  ctx.systemPrompt.section({
    name: 'minimi:instructions',
    order: 9000,
    text: MINIMI_INSTRUCTIONS,
  })

  ctx.systemPrompt.context({
    name: 'minimi:dated-memory',
    order: 8000,
    text: () => {
      try {
        const agent = ctx.agents.currentInitiator()
        const sessionId: string | undefined = agent?.session.header.id ?? latestSessionId ?? undefined
        if (!sessionId) return ''
        const userText = latestUserBySession.get(sessionId) ?? ''
        if (!userText.trim()) return ''
        const tz = tzFor(sessionId)
        const recall = store.recall({ userText, tz, now: Date.now(), excludeSessionId: sessionId, excludeTurn: agent ? ctx.agents.turnBoundaryOf(agent.session).lastTurn : budgets.get(sessionId)?.turn })
        const rendered = renderMemoryContext(recall, tz)
        if (config.debug) {
          writeDebug('last-memory-context.txt', `session=${sessionId}\nturn_user=${userText}\n\n${rendered}`)
        }
        return rendered
      } catch (err) {
        debugLog('memory provider failed', String(err))
        return ''
      }
    },
  })

  // ── DSH session hooks: persist turns and audit the tool boundary ──────────
  ctx.on('agent/pre-step', async (payload: any, next: () => Promise<unknown>) => {
    try {
      const sessionId: string = payload.agent.session.header.id
      const tz = sourceTz(payload.messages?.[0], fallbackTz)
      tzBySession.set(sessionId, tz)
      for (const message of payload.messages ?? []) {
        const text = messageText(message)
        if (text && (message?.source?.kind === 'user' || !message?.source)) {
          latestUserBySession.set(sessionId, text)
          latestSessionId = sessionId
        }
      }
      const schemas = ctx.tools.schemas(payload.agent).map((s: { name: string }) => s.name)
      writeDebug('runtime-tools.json', {
        sessionId,
        turn: ctx.agents.turnBoundaryOf(payload.agent.session).lastTurn,
        tools: schemas,
        updatedAt: new Date().toISOString(),
      })
      const disabled = ['bash', 'pwsh', 'read_file', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'ask_user_question', 'todo_write', 'run_code', 'subagent', 'subagent_fork']
      const registered = Object.fromEntries(disabled.map((n) => [n, Boolean(ctx.tools.get(n, payload.agent))]))
      writeDebug('tool-boundary.json', { visible: schemas, disabledProbe: registered, updatedAt: new Date().toISOString() })
      debugLog('runtime tools', schemas)
    } catch (err) {
      debugLog('pre-step hook failed', String(err))
    }
    return next()
  })

  ctx.on('agent/assistant-stream', (payload: any, maybeFrame?: any) => {
    try {
      const frame = payload?.frame ?? maybeFrame ?? payload
      const agent = payload?.agent
      const chunk = frame?.chunk
      const hasText = (chunk?.type === 'text-delta' && String(chunk.text ?? '').trim()) || (chunk?.type === 'text-chunks' && (chunk.texts ?? []).join('').trim())
      if (frame?.type === 'chunk' && hasText) {
        obs.firstText(agent?.session?.header?.id, Number(frame.turn))
      }
    } catch { /* ignore */ }
  })

  ctx.on('session/event', (session: any, event: any) => {
    try {
      const sessionId: string = session.header.id
      if (event.type === 'turn/start') {
        obs.begin(sessionId, event.data.turn)
        budgetFor(sessionId, event.data.turn)
        store.beginTurn(sessionId, event.data.turn, tzFor(sessionId))
      } else if (event.type === 'user/message') {
        const kind = event.data?.source?.kind
        if (kind && kind !== 'user') return
        const text = messageText(event.data)
        if (!text) return
        const tz = sourceTz(event.data, tzFor(sessionId))
        tzBySession.set(sessionId, tz)
        latestUserBySession.set(sessionId, text)
        latestSessionId = sessionId
        const turn = budgets.get(sessionId)?.turn ?? ctx.agents.turnBoundaryOf(session).lastTurn
        obs.user(sessionId, turn, text)
        store.beginTurn(sessionId, turn, tz, Date.now())
        store.setUser(sessionId, turn, text, tz)
      } else if (event.type === 'step/start') {
        obs.stepStart(sessionId, Number(event.data.turn), Number(event.data.step))
      } else if (event.type === 'assistant/message') {
        const text = messageText(event.data.message)
        const turn = Number(event.data.turn)
        obs.assistant(sessionId, turn, text, event.data.usage, Boolean(event.data.interrupted), Number(event.data.step))
        if (text) store.setAssistant(sessionId, turn, text, Boolean(event.data.interrupted))
      } else if (event.type === 'turn/end') {
        obs.end(sessionId, Number(event.data.turn))
      } else if (event.type === 'request/header') {
        const tools = Array.isArray(event.data.header?.tools)
          ? event.data.header.tools.map((t: { name?: string }) => t?.name).filter(Boolean)
          : []
        writeDebug('runtime-tools.json', {
          sessionId,
          turn: ctx.agents.turnBoundaryOf(session).lastTurn,
          tools,
          updatedAt: new Date().toISOString(),
        })
      }
    } catch (err) {
      debugLog('session event hook failed', String(err))
    }
  })
}
