#!/usr/bin/env node
/** Aggregate the live Minimi turn metrics written by plugin/src/observability.ts. */
import fs from 'node:fs'
import path from 'node:path'

const file = process.argv[2] || path.resolve('data/observability/turns.jsonl')
if (!fs.existsSync(file)) {
  console.error(`No observability file: ${file}`)
  process.exit(1)
}
const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const nums = (key) => rows.map((r) => r[key]).filter((v) => typeof v === 'number')
const p = (q) => { const v = nums('duration_ms').sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * q))] : null }
const sum = (key) => nums(key).reduce((a, b) => a + b, 0)
const avg = (key) => { const v = nums(key); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const out = {
  turns: rows.length,
  duration_ms: { p50: p(.5), p95: p(.95), max: p(1) },
  first_answer_text_ms: { p50: (() => { const v = nums('first_answer_text_ms').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length * .5)] : null })(), n: nums('first_answer_text_ms').length },
  model_calls: { total: sum('model_calls'), avg: avg('model_calls') },
  tool_calls: { total: sum('tool_calls'), avg: avg('tool_calls') },
  search_attempts: { total: sum('search_attempts') },
  citations: { total: sum('citations') },
  tokens: { input: sum('input_tokens'), output: sum('output_tokens'), cache_hit: sum('cache_hit_tokens'), cache_miss: sum('cache_miss_tokens') },
  cost_usd: { total: Number(sum('cost_usd').toFixed(6)), avg: avg('cost_usd') },
  interrupted: rows.filter((r) => r.interrupted).length,
  errors: rows.filter((r) => r.error).length,
}
console.log(JSON.stringify(out, null, 2))
