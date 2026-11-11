import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Observability } from '../plugin/src/observability.ts'
import { resolveWindow } from '../plugin/src/memory.ts'

test('date windows honor explicit month/day and ordinal dates over a trailing today', () => {
  const now = Date.parse('2026-11-11T11:30:00Z')
  const nov5 = resolveWindow('on nov 5, true today?', 'Asia/Kolkata', now)
  assert.equal(nov5.from, Date.parse('2026-11-04T18:30:00Z'))
  const ninth = resolveWindow('what were my asks on the 9th?', 'Asia/Kolkata', now)
  assert.equal(ninth.from, Date.parse('2026-11-08T18:30:00Z'))
})

test('live observability writes a complete turn metric row and span tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimi-obs-'))
  const file = path.join(dir, 'turns.jsonl')
  const obs = new Observability(file)
  obs.begin('session-test', 1)
  obs.user('session-test', 1, 'What is the price?')
  obs.stepStart('session-test', 1, 1)
  obs.firstText('session-test', 1)
  obs.assistant('session-test', 1, 'It is $24.', { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 }, false, 1)
  obs.tool('session-test', 1, { queries: ['price'], attempts: 2, citations: 1, durationMs: 12 })
  obs.end('session-test', 1)
  const row = JSON.parse(fs.readFileSync(file, 'utf8').trim())
  assert.equal(row.session_id, 'session-test')
  assert.equal(row.input_tokens, 140)
  assert.equal(row.output_tokens, 10)
  assert.equal(row.cache_hit_tokens, 40)
  assert.equal(row.cache_miss_tokens, 100)
  assert.ok(row.cost_usd > 0)
  assert.equal(row.search_attempts, 2)
  assert.ok(row.spans.some((s) => s.name === 'tool.web_search'))
  fs.rmSync(dir, { recursive: true, force: true })
})
