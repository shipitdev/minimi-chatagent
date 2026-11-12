#!/usr/bin/env node
/**
 * Upload live Minimi turn metrics/spans to LangSmith.
 *
 * Reads data/observability/turns.jsonl, creates the live project when needed,
 * and writes one trace tree per turn. LLM children carry standard
 * `usage_metadata` (including cache details and cost) so LangSmith can show
 * input/output tokens and cost instead of only a chain-level text row.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RunTree } from 'langsmith/run_trees'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = process.env.LANGSMITH_LIVE_PROJECT || 'minimi-live'
const ENDPOINT = process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com'
const KEY = process.env.LANGSMITH_API_KEY || ''
const FILE = process.env.MINIMI_OBSERVABILITY_FILE || path.resolve(ROOT, '..', 'data/observability/turns.jsonl')
const STATE = path.resolve(ROOT, `.observability-exported-${PROJECT.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`)
const MODEL = process.env.DEEPEVAL_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-flash'
const PRICE = {
  inputMiss: Number(process.env.MINIMI_PRICE_INPUT_MISS || 0.14) / 1e6,
  inputHit: Number(process.env.MINIMI_PRICE_INPUT_HIT || 0.028) / 1e6,
  output: Number(process.env.MINIMI_PRICE_OUTPUT || 0.56) / 1e6,
}

if (!KEY) {
  console.error('[trace] LANGSMITH_API_KEY is not set; live export disabled')
  process.exit(0)
}

async function preflight() {
  const res = await fetch(`${ENDPOINT}/api/v1/sessions?limit=1`, { headers: { 'x-api-key': KEY } })
  if (!res.ok) throw new Error(`LangSmith preflight HTTP ${res.status}`)
}
async function ensureProject(name) {
  const list = await fetch(`${ENDPOINT}/api/v1/sessions?limit=100`, { headers: { 'x-api-key': KEY } })
  if (!list.ok) throw new Error(`LangSmith projects HTTP ${list.status}`)
  const sessions = await list.json()
  const found = sessions.find((s) => s.name === name)
  if (found) return found.id
  const created = await fetch(`${ENDPOINT}/api/v1/sessions`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ name, description: 'Minimi live DSH turn metrics and spans' }),
  })
  if (!created.ok) throw new Error(`LangSmith create project HTTP ${created.status}`)
  return (await created.json()).id
}

function readRows() {
  try {
    return fs.readFileSync(FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch { return [] }
}
function readState() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE, 'utf8')).exported ?? []) } catch { return new Set() }
}
function writeState(set) {
  fs.writeFileSync(STATE, JSON.stringify({ exported: [...set] }, null, 2) + '\n')
}
function runTypeFor(name) {
  if (name.startsWith('llm.')) return 'llm'
  if (name.startsWith('retriever.')) return 'retriever'
  if (name.startsWith('tool.')) return 'tool'
  return 'chain'
}

/** Normalize DSH's split usage into LangSmith's UsageMetadata shape. */
function usageMetadata(uncachedInput, output, cacheRead = 0, cacheWrite = 0, fixedCost) {
  const inputTokens = uncachedInput + cacheRead + cacheWrite
  const inputCost = fixedCost ?? (uncachedInput + cacheWrite) * PRICE.inputMiss + cacheRead * PRICE.inputHit
  const outputCost = output * PRICE.output
  return {
    input_tokens: inputTokens,
    output_tokens: output,
    total_tokens: inputTokens + output,
    input_token_details: { cache_read: cacheRead, cache_creation: cacheWrite },
    input_cost: Number(inputCost.toFixed(9)),
    output_cost: Number(outputCost.toFixed(9)),
    total_cost: Number((inputCost + outputCost).toFixed(9)),
  }
}

async function upload(row) {
  const root = new RunTree({
    name: 'minimi.live.turn',
    run_type: 'chain',
    inputs: {
      user_text: row.user_text,
      session_id: row.session_id,
      turn: row.turn,
      route: row.route,
    },
    metadata: {
      trace_id: row.trace_id,
      session_id: row.session_id,
      turn: row.turn,
      route: row.route,
      model_calls: row.model_calls,
      tool_calls: row.tool_calls,
      search_attempts: row.search_attempts,
      citations: row.citations,
      interrupted: row.interrupted,
      first_answer_text_ms: row.first_answer_text_ms,
      estimated_cost_usd: row.cost_usd,
      source: 'minimi-live-observability',
    },
    tags: ['minimi', 'live', row.route, row.interrupted ? 'interrupted' : 'completed'],
    start_time: row.started_at,
    project_name: PROJECT,
  })
  await root.postRun()
  for (const span of row.spans ?? []) {
    const llm = span.name.startsWith('llm.')
    const raw = span.outputs?.usage ?? {}
    const childUsage = llm
      ? usageMetadata(
        Number(raw.inputTokens ?? 0),
        Number(raw.outputTokens ?? 0),
        Number(raw.cacheReadTokens ?? 0),
        Number(raw.cacheWriteTokens ?? 0),
      )
      : undefined
    const childOutputs = { ...(span.outputs ?? {}) }
    if (childUsage) {
      childOutputs.usage_metadata = childUsage
      childOutputs.prompt_tokens = childUsage.input_tokens
      childOutputs.completion_tokens = childUsage.output_tokens
      childOutputs.total_tokens = childUsage.total_tokens
    }
    const child = root.createChild({
      name: span.name,
      run_type: runTypeFor(span.name),
      inputs: span.inputs ?? {},
      metadata: {
        duration_ms: span.duration_ms,
        ...(llm ? {
          ls_provider: 'deepseek',
          ls_model_name: MODEL,
          ls_model_type: 'chat',
          usage_metadata: childUsage,
        } : {}),
      },
      start_time: span.start,
    })
    await child.postRun()
    await child.end(
      childOutputs,
      span.error || undefined,
      span.end ?? undefined,
    )
    await child.patchRun({ excludeInputs: false })
  }
  const outputs = {
    assistant_text: row.assistant_text,
    route: row.route,
    duration_ms: row.duration_ms,
    first_answer_text_ms: row.first_answer_text_ms,
    model_calls: row.model_calls,
    tool_calls: row.tool_calls,
    search_attempts: row.search_attempts,
    citations: row.citations,
    interrupted: row.interrupted,
    estimated_cost_usd: row.cost_usd,
  }
  await root.end(outputs, row.error || undefined, row.ended_at)
  await root.patchRun({ excludeInputs: false })
  return root.id
}

async function once(verbose = true) {
  const rows = readRows()
  const exported = readState()
  let added = 0
  for (const row of rows) {
    if (exported.has(row.trace_id)) continue
    const id = await upload(row)
    exported.add(row.trace_id)
    writeState(exported)
    added++
    if (verbose) console.log(`[trace] ${row.trace_id} -> ${id}`)
  }
  return added
}

try {
  await preflight()
  const projectId = await ensureProject(PROJECT)
  console.log(`[trace] LangSmith project ${PROJECT} (${projectId})`)
  let added = await once()
  console.log(`[trace] exported ${added} live turn(s) to https://smith.langchain.com/projects/p/${projectId}`)
  if (process.argv.includes('--watch')) {
    let running = true
    process.on('SIGTERM', () => { running = false })
    process.on('SIGINT', () => { running = false })
    while (running) {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      try { const n = await once(true); if (n) console.log(`[trace] ${n} new turn(s)`) } catch (err) { console.error(`[trace] ${err.message}`) }
    }
  }
} catch (err) {
  console.error(`[trace] LangSmith live export unavailable: ${err.message}`)
  process.exit(0)
}
