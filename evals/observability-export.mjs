#!/usr/bin/env node
/**
 * Upload live Minimi turn metrics/spans to LangSmith.
 *
 * Reads data/observability/turns.jsonl, creates the `minimi-live` project when
 * needed, and writes one trace tree per turn. `--watch` polls for new turns so a
 * public demo can stream live observability into the LangSmith panel.
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
const STATE = path.resolve(ROOT, '.observability-exported.json')

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
  if (name.startsWith('tool.')) return 'tool'
  return 'chain'
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
    const child = root.createChild({
      name: span.name,
      run_type: runTypeFor(span.name),
      inputs: span.inputs ?? {},
      metadata: { duration_ms: span.duration_ms },
      start_time: span.start,
    })
    await child.postRun()
    await child.end(
      span.outputs ?? {},
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
    usage_metadata: {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_hit_tokens,
      cache_write_tokens: 0,
      input_token_details: { cache_read: row.cache_hit_tokens, cache_creation: 0 },
    },
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
