#!/usr/bin/env node
/**
 * Replay local golden trace trees to LangSmith.
 *
 * The adapter always writes local JSON trees so evaluation cannot depend on the
 * tracing service. Once LANGSMITH_API_KEY has access, run this to upload the
 * same trees with their latency/token/cost metrics.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RunTree } from 'langsmith/run_trees'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const TRACE_DIR = path.join(ROOT, 'runs', 'traces')
const ENDPOINT = process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com'
const PROJECT = process.env.LANGSMITH_PROJECT || 'minimi-golden-v2'
const KEY = process.env.LANGSMITH_API_KEY || ''

if (!KEY) {
  console.error('LANGSMITH_API_KEY is not set')
  process.exit(2)
}
const preflight = await fetch(`${ENDPOINT}/api/v1/sessions?limit=1`, { headers: { 'x-api-key': KEY } })
if (!preflight.ok) {
  console.error(`LangSmith key preflight failed: HTTP ${preflight.status} from ${ENDPOINT}`)
  process.exit(2)
}

async function post(node, parent) {
  const config = {
    name: node.name,
    run_type: node.run_type,
    inputs: node.inputs ?? {},
    start_time: node.start_time,
    metadata: node.metadata ?? {},
    project_name: PROJECT,
    ...(parent ? { parent_run: parent } : {}),
  }
  const run = parent ? parent.createChild(config) : new RunTree(config)
  await run.postRun()
  for (const child of node.children ?? []) await post(child, run)
  await run.end(node.outputs ?? {}, node.error || undefined)
  await run.patchRun({ excludeInputs: false })
  return run
}

const files = fs.readdirSync(TRACE_DIR).filter((f) => f.endsWith('.json')).sort()
let count = 0
for (const file of files) {
  const trace = JSON.parse(fs.readFileSync(path.join(TRACE_DIR, file), 'utf8'))
  const run = await post(trace.root)
  console.log(`${file} -> ${run.id}`)
  count++
}
console.log(`exported ${count} traces to ${PROJECT} at ${ENDPOINT}`)
