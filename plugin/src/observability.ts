/**
 * Local observability for live Minimi turns.
 *
 * DSH owns the model loop, so the plugin records the facts DSH exposes: turn
 * boundaries, durable assistant usage, stream first-text time, and web_search
 * execution. Each turn is one JSON object with a compact span tree and the same
 * latency/token/cost metrics the golden adapter emits. This sink is local and
 * no-throw; LangSmith upload can replay these trees separately.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const num = (name: string, fallback: number): number => {
  const n = Number(process.env[name])
  return Number.isFinite(n) ? n : fallback
}

const PRICE = {
  inputMiss: num('MINIMI_PRICE_INPUT_MISS', 0.14) / 1e6,
  inputHit: num('MINIMI_PRICE_INPUT_HIT', 0.028) / 1e6,
  output: num('MINIMI_PRICE_OUTPUT', 0.56) / 1e6,
}

interface Span {
  name: string
  start: string
  end?: string
  duration_ms?: number
  inputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
  error?: string
}

interface TurnState {
  traceId: string
  startedAt: number
  startedIso: string
  userText: string
  assistantText: string
  firstTextMs: number | null
  stepStartedAt: number | null
  modelCalls: number
  toolCalls: number
  searchAttempts: number
  searchQueries: string[]
  citations: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  spans: Span[]
  interrupted: boolean
  error: string | null
}

export class Observability {
  private readonly file: string
  private readonly dir: string
  private readonly turns = new Map<string, TurnState>()
  private readonly enabled: boolean

  constructor(file = path.resolve('data/observability/turns.jsonl')) {
    this.file = file
    this.dir = path.dirname(file)
    this.enabled = process.env.MINIMI_OBSERVABILITY !== '0'
    if (this.enabled) {
      try { fs.mkdirSync(this.dir, { recursive: true }) } catch { /* ignore */ }
    }
  }

  private key(sessionId: string, turn: number): string { return `${sessionId}:${turn}` }

  begin(sessionId: string, turn: number): void {
    if (!this.enabled) return
    const now = Date.now()
    this.turns.set(this.key(sessionId, turn), {
      traceId: crypto.randomUUID(),
      startedAt: now,
      startedIso: new Date(now).toISOString(),
      userText: '',
      assistantText: '',
      firstTextMs: null,
      stepStartedAt: null,
      modelCalls: 0,
      toolCalls: 0,
      searchAttempts: 0,
      searchQueries: [],
      citations: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      spans: [],
      interrupted: false,
      error: null,
    })
  }

  user(sessionId: string, turn: number, text: string): void {
    const state = this.turns.get(this.key(sessionId, turn))
    if (state) state.userText = text.slice(0, 4000)
  }

  stepStart(sessionId: string, turn: number, step: number): void {
    const state = this.turns.get(this.key(sessionId, turn))
    if (!state) return
    state.stepStartedAt = Date.now()
    state.spans.push({ name: `llm.step.${step}`, start: new Date().toISOString(), inputs: { step } })
  }

  firstText(sessionId: string, turn: number): void {
    const state = this.turns.get(this.key(sessionId, turn))
    if (!state || state.firstTextMs !== null) return
    state.firstTextMs = Date.now() - state.startedAt
  }

  assistant(sessionId: string, turn: number, text: string, usage: Record<string, number> | undefined, interrupted: boolean, step?: number): void {
    const state = this.turns.get(this.key(sessionId, turn))
    if (!state) return
    const now = Date.now()
    state.modelCalls++
    state.assistantText = text.slice(0, 8000)
    state.interrupted = state.interrupted || interrupted
    if (text.trim() && state.firstTextMs === null) state.firstTextMs = now - state.startedAt
    const uncached = Number(usage?.inputTokens ?? usage?.promptTokens ?? 0)
    const cacheRead = Number(usage?.cacheReadTokens ?? usage?.cacheHitTokens ?? 0)
    const cacheWrite = Number(usage?.cacheWriteTokens ?? 0)
    state.inputTokens += uncached + cacheRead + cacheWrite
    state.outputTokens += Number(usage?.outputTokens ?? usage?.completionTokens ?? 0)
    state.cacheHitTokens += cacheRead
    state.cacheMissTokens += uncached + cacheWrite
    const span = [...state.spans].reverse().find((s) => s.name.startsWith('llm.step.') && !s.end)
    if (span) {
      span.end = new Date(now).toISOString()
      span.duration_ms = state.stepStartedAt ? now - state.stepStartedAt : undefined
      span.outputs = { text: text.slice(0, 500), usage: usage ?? null, interrupted }
    }
  }

  recall(sessionId: string, turn: number, input: {
    query: string
    tz: string
    durationMs: number
    window: { from: number; to: number; label: string } | null
    turns: Array<{ sessionId: string; turn: number; startedAt: number; userText: string }>
    facts: Array<{ entity: string; attribute: string; value: string; citationId: string }>
    snapshots: Array<{ subject: string; updatedAt: number }>
    renderedChars: number
  }): void {
    const state = this.turns.get(this.key(sessionId, turn))
    if (!state) return
    const started = new Date(Date.now() - input.durationMs).toISOString()
    state.spans.push({
      name: 'retriever.memory.recall',
      start: started,
      end: new Date().toISOString(),
      duration_ms: input.durationMs,
      inputs: {
        query: input.query,
        tz: input.tz,
        exclude_session_id: sessionId,
        exclude_turn: turn,
        sql: [
          'SELECT * FROM turns ORDER BY started_at DESC LIMIT 400',
          'SELECT * FROM facts ORDER BY created_at DESC LIMIT 600',
          'SELECT * FROM snapshots ORDER BY updated_at DESC LIMIT 100',
        ],
      },
      outputs: {
        window: input.window,
        turns: input.turns.map((t) => ({
          session_id: t.sessionId,
          turn: t.turn,
          started_at: new Date(t.startedAt).toISOString(),
          user_text: t.userText.slice(0, 300),
        })),
        facts: input.facts.map((f) => ({
          entity: f.entity,
          attribute: f.attribute,
          value: f.value,
          citation_id: f.citationId,
        })),
        snapshots: input.snapshots.map((s) => ({
          subject: s.subject,
          updated_at: new Date(s.updatedAt).toISOString(),
        })),
        counts: { turns: input.turns.length, facts: input.facts.length, snapshots: input.snapshots.length },
        rendered_chars: input.renderedChars,
        rendered_tokens_est: Math.ceil(input.renderedChars / 4),
      },
    })
  }

  tool(sessionId: string, turn: number, input: { queries: string[]; attempts: number; citations: number; durationMs: number; error?: string }): void {
    const state = this.turns.get(this.key(sessionId, turn))
    if (!state) return
    state.toolCalls++
    state.searchAttempts += input.attempts
    state.searchQueries.push(...input.queries)
    state.citations += input.citations
    state.spans.push({
      name: 'tool.web_search',
      start: new Date(Date.now() - input.durationMs).toISOString(),
      end: new Date().toISOString(),
      duration_ms: input.durationMs,
      inputs: { queries: input.queries },
      outputs: { attempts: input.attempts, citations: input.citations },
      error: input.error,
    })
  }

  error(sessionId: string, turn: number, error: string): void {
    const state = this.turns.get(this.key(sessionId, turn))
    if (state) state.error = error.slice(0, 1000)
  }

  end(sessionId: string, turn: number): void {
    const state = this.turns.get(this.key(sessionId, turn))
    if (!state) return
    this.turns.delete(this.key(sessionId, turn))
    const endedAt = Date.now()
    const cost = state.cacheMissTokens * PRICE.inputMiss + state.cacheHitTokens * PRICE.inputHit + state.outputTokens * PRICE.output
    const route = state.searchQueries.length > 0 ? 'research' : 'direct'
    const record = {
      trace_id: state.traceId,
      session_id: sessionId,
      turn,
      started_at: state.startedIso,
      ended_at: new Date(endedAt).toISOString(),
      duration_ms: endedAt - state.startedAt,
      first_answer_text_ms: state.firstTextMs,
      route,
      user_text: state.userText,
      assistant_text: state.assistantText,
      interrupted: state.interrupted,
      error: state.error,
      model_calls: state.modelCalls,
      tool_calls: state.toolCalls,
      search_attempts: state.searchAttempts,
      search_queries: [...new Set(state.searchQueries)],
      citations: state.citations,
      input_tokens: state.inputTokens,
      output_tokens: state.outputTokens,
      cache_hit_tokens: state.cacheHitTokens,
      cache_miss_tokens: state.cacheMissTokens,
      cost_usd: Number(cost.toFixed(6)),
      spans: state.spans,
    }
    try {
      fs.appendFileSync(this.file, JSON.stringify(record) + '\n')
      const dir = path.join(this.dir, 'turns')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${sessionId.replace(/[^a-zA-Z0-9_.-]+/g, '_')}-${turn}.json`), JSON.stringify(record, null, 2))
    } catch { /* observability must never break a turn */ }
  }
}
