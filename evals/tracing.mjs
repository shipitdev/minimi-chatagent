/**
 * LangSmith + local trace tree for the golden adapter.
 *
 * Every case is one trace tree: case -> memory recall -> model calls -> tool ->
 * query/fetch/digest children. LangSmith export is enabled only after a cheap
 * key preflight; a forbidden/expired key falls back to a durable local JSON tree
 * so evaluation and DeepEval never depend on the tracing service.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { RunTree } from 'langsmith/run_trees'

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const TRACE_DIR = path.join(ROOT, 'runs', 'traces')
const STATUS_FILE = path.join(ROOT, '.langsmith-status.json')
const ENDPOINT = process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com'
const PROJECT = process.env.LANGSMITH_PROJECT || 'minimi-golden-v2'

function keyHash(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
}

async function preflight(key) {
  if (!key) return { enabled: false, error: 'LANGSMITH_API_KEY is not set' }
  const hash = keyHash(key)
  try {
    const cached = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'))
    if (cached.hash === hash && Date.now() - cached.checkedAt < 60 * 60 * 1000 && !process.env.LANGSMITH_FORCE) {
      return { enabled: cached.enabled, error: cached.error }
    }
  } catch { /* no cache */ }
  let enabled = false
  let error = null
  try {
    const res = await fetch(`${ENDPOINT}/api/v1/sessions?limit=1`, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(15000),
    })
    enabled = res.ok
    if (!res.ok) error = `HTTP ${res.status} from ${ENDPOINT} key preflight`
  } catch (err) {
    error = `LangSmith preflight failed: ${err instanceof Error ? err.message : String(err)}`
  }
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ hash, enabled, error, checkedAt: Date.now() })) } catch { /* ignore */ }
  return { enabled, error }
}

function localNode(name, type, inputs, metadata = {}) {
  return {
    id: crypto.randomUUID(),
    name,
    run_type: type,
    start_time: new Date().toISOString(),
    inputs,
    metadata,
    children: [],
    outputs: null,
    error: null,
    end_time: null,
  }
}

export async function createCaseTracer({ caseId, split, inputs, metadata = {} }) {
  const key = process.env.LANGSMITH_API_KEY || ''
  const tracingOff = process.env.LANGSMITH_TRACING === 'false'
  const status = tracingOff ? { enabled: false, error: 'LANGSMITH_TRACING=false' } : await preflight(key)
  const local = localNode('minimi.golden.case', 'chain', inputs, { case_id: caseId, split, ...metadata })
  const trace = {
    caseId,
    project: PROJECT,
    endpoint: ENDPOINT,
    langsmith: { enabled: status.enabled, error: status.error },
    root: local,
    run: null,
    traceId: local.id,
  }

  if (status.enabled) {
    try {
      const run = new RunTree({
        name: 'minimi.golden.case',
        run_type: 'chain',
        inputs,
        project_name: PROJECT,
        metadata: { case_id: caseId, split, ...metadata },
        tags: ['minimi', 'golden-v2', split],
      })
      await run.postRun()
      trace.run = run
      trace.traceId = run.id
      local.id = run.id
    } catch (err) {
      trace.langsmith = { enabled: false, error: `LangSmith start failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  async function child(parent, name, type, childInputs, childMetadata = {}) {
    const node = localNode(name, type, childInputs, childMetadata)
    const parentLocal = parent.local ?? parent
    parentLocal.children.push(node)
    let run = null
    if (trace.run) {
      const parentRun = parent.run ?? trace.run
      try {
        run = parentRun.createChild({ name, run_type: type, inputs: childInputs, metadata: childMetadata })
        await run.postRun()
      } catch (err) {
        trace.langsmith = { enabled: false, error: `LangSmith child failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
    return {
      local: node,
      run,
      id: node.id,
      async end(outputs = {}, error = null) {
        node.outputs = outputs
        node.error = error
        node.end_time = new Date().toISOString()
        if (run) {
          try {
            await run.end(outputs, error || undefined)
            await run.patchRun({ excludeInputs: false })
          } catch { /* tracing must not fail a case */ }
        }
      },
      async child(name2, type2, inputs2, metadata2 = {}) {
        return child(this, name2, type2, inputs2, metadata2)
      },
    }
  }

  return {
    trace,
    traceId: () => trace.traceId,
    langsmith: () => trace.langsmith,
    async child(name, type, childInputs, childMetadata = {}) {
      return child({ local, run: trace.run }, name, type, childInputs, childMetadata)
    },
    async finish(outputs, error = null) {
      local.outputs = outputs
      local.error = error
      local.end_time = new Date().toISOString()
      if (trace.run) {
        try {
          await trace.run.end(outputs, error || undefined)
          await trace.run.patchRun({ excludeInputs: false })
        } catch { /* ignore */ }
      }
      try {
        fs.mkdirSync(TRACE_DIR, { recursive: true })
        const safe = String(caseId).replace(/[^a-zA-Z0-9_.-]+/g, '_')
        fs.writeFileSync(path.join(TRACE_DIR, `${safe}.json`), JSON.stringify(trace, null, 2))
      } catch { /* local trace is best-effort */ }
    },
  }
}
