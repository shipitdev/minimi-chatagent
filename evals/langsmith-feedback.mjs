#!/usr/bin/env node
/** Attach DeepEval and structural scores to the uploaded golden trace roots. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'langsmith'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = process.env.LANGSMITH_PROJECT || 'minimi-golden-v2'
const SUMMARY = path.join(ROOT, 'runs', 'deepeval-summary.json')
const KEY = process.env.LANGSMITH_API_KEY || ''
if (!KEY) { console.error('LANGSMITH_API_KEY is not set'); process.exit(2) }
if (!fs.existsSync(SUMMARY)) { console.error(`missing ${SUMMARY}`); process.exit(2) }

const data = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'))
const golden = new Map()
for (const split of ['dev', 'holdout', 'live']) {
  const file = path.join(ROOT, 'runs', `${split}.json`)
  if (!fs.existsSync(file)) continue
  for (const row of JSON.parse(fs.readFileSync(file, 'utf8')).results) golden.set(row.id, row)
}
const deepeval = new Map(Object.entries(data.per_case ?? {}))
const client = new Client({ apiKey: KEY })
const roots = new Map()
for await (const r of client.listRuns({ projectName: PROJECT, filter: 'eq(name, "minimi.golden.case")', limit: 100 })) {
  const caseId = r.extra?.metadata?.case_id
  if (caseId) roots.set(caseId, r.id)
}
console.log(`found ${roots.size} golden trace roots`)

let written = 0
const existing = new Map()
async function hasFeedback(runId, key) {
  if (!existing.has(runId)) {
    const keys = new Set()
    for await (const f of client.listFeedback({ runIds: [runId] })) keys.add(f.key)
    existing.set(runId, keys)
  }
  return existing.get(runId).has(key)
}
async function feedback(caseId, key, score, comment) {
  const runId = roots.get(caseId)
  if (!runId || typeof score !== 'number') return
  if (await hasFeedback(runId, key)) return
  await client.createFeedback(runId, key, { score, comment: String(comment ?? '').slice(0, 1000) })
  existing.get(runId).add(key)
  written++
}

for (const [caseId, entry] of deepeval) {
  const wf = entry.workflow?.case_compliance
  if (wf?.score != null) await feedback(caseId, 'deepeval.workflow.compliance', wf.score, wf.reason)
  const faith = entry.pipeline?.faithfulness
  if (faith?.score != null) await feedback(caseId, 'deepeval.pipeline.faithfulness', faith.score, faith.reason)
  const rel = entry.pipeline?.answer_relevancy
  if (rel?.score != null) await feedback(caseId, 'deepeval.pipeline.answer_relevancy', rel.score, rel.reason)
  const rec = entry.component?.contextual_recall
  if (rec?.score != null) await feedback(caseId, 'deepeval.component.contextual_recall', rec.score, rec.reason)
}

for (const [caseId, row] of golden) {
  for (const [key, value] of Object.entries(row.checks ?? {})) {
    if (typeof value === 'number') await feedback(caseId, `golden.${key}`, value, `Golden v2 structural check ${key}`)
  }
  const r = row.result ?? {}
  if (typeof r.model_calls === 'number') await feedback(caseId, 'telemetry.model_calls', r.model_calls, 'Adapter model calls for this case')
  if (typeof r.cost_usd === 'number') await feedback(caseId, 'telemetry.cost_usd', r.cost_usd, 'Estimated adapter model cost for this case')
}
console.log(`attached ${written} feedback score(s) to ${PROJECT}`)
