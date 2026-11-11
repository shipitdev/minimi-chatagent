import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimi-unit-'))
const fixtures = path.join(tmpRoot, 'fixtures')
fs.mkdirSync(fixtures, { recursive: true })
process.env.MINIMI_SEARCH_FIXTURES = fixtures
process.env.MINIMI_DB = path.join(tmpRoot, 'default.db')
process.env.MINIMI_DEBUG = '0'

const { buildDigest } = await import('../plugin/src/digest.ts')
const { comparePriceTerms, formatTerm, parsePriceTerms } = await import('../plugin/src/billing.ts')
const { MemoryStore } = await import('../plugin/src/memory.ts')
const { runSearchBatch } = await import('../plugin/src/report.ts')

function writeFixtures(search, fetch = null) {
  fs.writeFileSync(path.join(fixtures, 'search.json'), JSON.stringify(search))
  fs.writeFileSync(path.join(fixtures, 'fetch.json'), JSON.stringify(fetch ?? { '*': { title: 'Fetched page', content: '' } }))
}

function result(overrides = {}) {
  return {
    title: 'Cursor 1.0 release notes',
    url: 'https://example.com/cursor-1-0',
    summary:
      'Cursor 1.0.0 is the latest version. Cursor Pro costs $20 per user per month, billed monthly. Cursor supports Windows and macOS. Cursor added a new agent mode.',
    date: '2026-01-01T00:00:00Z',
    authority: 4,
    rerank_score: 3,
    ...overrides,
  }
}

before(() => {
  writeFixtures({ '*': [result()] }, { '*': { title: 'Cursor 1.0 release notes', content: result().summary } })
})

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('digest keeps claim-sized cited evidence and removes duplicate sources', () => {
  const digest = buildDigest({
    question: 'Cursor Pro price',
    results: [
      result(),
      result({ title: 'Duplicate', rerank_score: 1 }),
      result({ title: 'Unrelated', url: 'https://example.com/other', summary: 'The weather is mild today. A cat sat on the mat.' }),
      result({ title: 'Syndicated copy', url: 'https://mirror.example.com/cursor', rerank_score: 0.5 }),
    ],
    budgetTokens: 500,
  })
  assert.equal(digest.citations.length, 3)
  assert.match(digest.block, /Cursor Pro costs \$20/)
  assert.match(digest.block, /\[1\]/)
  assert.ok(digest.stats.duplicatesRemoved >= 1)
  assert.ok(digest.facts.some((f) => f.attribute === 'price' && f.value === '$20'))
})

test('price comparison refuses different billing bases instead of inventing a delta', () => {
  const monthly = parsePriceTerms('Cursor Pro costs $20 per user per month, billed monthly.')[0]
  const annual = parsePriceTerms('Cursor Pro costs $240 per user per year, requires annual billing.')[0]
  const cmp = comparePriceTerms(monthly, annual)
  assert.equal(cmp.status, 'incomparable')
  assert.match(formatTerm(monthly), /monthly billing/)
  assert.match(formatTerm(annual), /annual commitment/)
  assert.ok(cmp.reason)
})

test('dated memory survives a store reopen and recalls a fact by topic', () => {
  const db = path.join(tmpRoot, 'memory.db')
  let store = new MemoryStore(db)
  const now = Date.now()
  store.beginTurn('session-test-1', 1, 'Asia/Calcutta', now)
  store.setUser('session-test-1', 1, 'My favorite database is DuckDB for analytics.', 'Asia/Calcutta')
  store.setAssistant('session-test-1', 1, 'Noted: DuckDB is your favorite analytics database.', false)
  store.close()

  store = new MemoryStore(db)
  const recall = store.recall({ userText: 'What is my favorite database?', tz: 'Asia/Calcutta', now })
  assert.equal(recall.turns.length, 1)
  assert.match(recall.turns[0].userText, /DuckDB/)
  assert.match(recall.turns[0].assistantText, /DuckDB/)
  assert.equal(store.turnCount(), 1)
  store.close()
})

test('change batch updates both version and price against the saved baseline', async () => {
  const db = path.join(tmpRoot, 'change.db')
  fs.rmSync(db, { force: true })
  const store = new MemoryStore(db)
  const deps = {
    store,
    sessionId: 'session-change',
    turn: 1,
    tz: 'Asia/Calcutta',
    now: Date.now(),
    signal: AbortSignal.timeout(10000),
    onAttempt: () => {},
    maxQueries: 3,
  }

  writeFixtures({ '*': [result()] }, { '*': { title: 'Cursor 1.0', content: result().summary } })
  const baseline = await runSearchBatch({ queries: [{ query: 'Cursor latest version price', subject: 'Cursor' }], intent: 'answer' }, deps)
  assert.equal(baseline.attempts, 2, 'search + internal fetch attempts are counted')
  const snap = store.getSnapshot('Cursor')
  assert.ok(snap)
  assert.ok(snap.facts.some((f) => f.attribute === 'version' && f.value === '1.0.0'))

  const v2 = result({
    title: 'Cursor 1.1 release notes',
    url: 'https://example.com/cursor-1-1',
    summary:
      'Cursor 1.1.0 is the latest version. Cursor Pro costs $25 per user per month, billed monthly. Cursor supports Windows and macOS. Cursor added a new agent mode.',
    date: '2026-02-01T00:00:00Z',
  })
  writeFixtures({ '*': [v2] }, { '*': { title: 'Cursor 1.1', content: v2.summary } })
  const changed = await runSearchBatch({ queries: [{ query: 'Cursor latest version price', subject: 'Cursor' }], intent: 'change' }, deps)
  assert.match(changed.text, /CHANGE CHECK/)
  assert.match(changed.text, /"1\.0\.0" -> "1\.1\.0"/)
  assert.match(changed.text, /\[updated\]/)
  assert.match(changed.text, /\$20 per user per month, monthly billing -> \$25 per user per month, monthly billing/)
  const updated = store.getSnapshot('Cursor')
  assert.ok(updated.facts.some((f) => f.attribute === 'version' && f.value === '1.1.0'))
  store.close()
})

test('change check cannot establish a price change across billing bases', async () => {
  const db = path.join(tmpRoot, 'incomparable.db')
  fs.rmSync(db, { force: true })
  const store = new MemoryStore(db)
  const deps = {
    store,
    sessionId: 'session-incomparable',
    turn: 1,
    tz: 'UTC',
    now: Date.now(),
    signal: AbortSignal.timeout(10000),
    onAttempt: () => {},
    maxQueries: 3,
  }
  writeFixtures({ '*': [result()] }, { '*': { title: 'Cursor 1.0', content: result().summary } })
  await runSearchBatch({ queries: [{ query: 'Cursor price', subject: 'Cursor' }], intent: 'answer' }, deps)

  const annual = result({
    title: 'Cursor annual plan',
    url: 'https://example.com/cursor-annual',
    summary: 'Cursor Pro costs $240 per user per year, requires annual billing. Cursor supports Windows and macOS.',
    date: '2026-02-01T00:00:00Z',
  })
  writeFixtures({ '*': [annual] }, { '*': { title: 'Cursor annual', content: annual.summary } })
  const changed = await runSearchBatch({ queries: [{ query: 'Cursor price', subject: 'Cursor' }], intent: 'change' }, deps)
  assert.match(changed.text, /CANNOT ESTABLISH A CHANGE/)
  assert.match(changed.text, /annual commitment/)
  store.close()
})

test('retry/replay of the same session turn updates instead of duplicating', () => {
  const db = path.join(tmpRoot, 'retry.db')
  fs.rmSync(db, { force: true })
  const store = new MemoryStore(db)
  const now = Date.now()
  store.beginTurn('session-retry', 1, 'UTC', now)
  store.setUser('session-retry', 1, 'A durable question', 'UTC')
  store.setAssistant('session-retry', 1, 'First partial', true)
  store.setAssistant('session-retry', 1, 'First partial + completed', false)
  assert.equal(store.turnCount(), 1)
  store.close()
})

test('empty evidence is reported as missing, not as a fact', () => {
  const digest = buildDigest({ question: 'A question with no evidence', results: [], budgetTokens: 300 })
  assert.equal(digest.citations.length, 0)
  assert.equal(digest.facts.length, 0)
  assert.match(digest.block, /no usable evidence/i)
})

test('recall selects the requested day, excludes current turn, and respects the limit', () => {
  const store = new MemoryStore(':memory:')
  const now = Date.parse('2026-11-11T12:00:00Z')
  for (let turn = 1; turn <= 9; turn++) {
    store.beginTurn('recall', turn, 'UTC', now - turn * 86400000)
    store.setUser('recall', turn, turn === 1 ? 'Atlas uses PostgreSQL' : `Unrelated topic ${turn}`, 'UTC')
    store.setAssistant('recall', turn, 'Noted', false)
    store.db.prepare('UPDATE turns SET started_at = ? WHERE turn = ?').run(now - turn * 86400000, turn)
  }
  store.beginTurn('current', 1, 'UTC', now)
  store.setUser('current', 1, 'Atlas yesterday', 'UTC')
  const recalled = store.recall({ userText: 'Atlas yesterday', tz: 'UTC', now, limitTurns: 1, excludeSessionId: 'current', excludeTurn: 1 })
  assert.deepEqual(recalled.turns.map(t => t.turn), [1])
  assert.equal(store.recall({ userText: 'unrelated-no-match', tz: 'UTC', now }).turns.length, 0)
  store.close()
})

test('historical facts and baselines do not include later observations', () => {
  const store = new MemoryStore(':memory:')
  const now = Date.parse('2026-11-11T12:00:00Z')
  const fact = { entity: 'Atlas', attribute: 'version', value: '99', kind: 'version', citationId: 'S1', url: 'https://example.com', title: 'Atlas', publishedAt: null, retrievedAt: new Date(now).toISOString(), qualifiers: [], evidence: 'Atlas version 99' }
  store.recordFacts('a', 1, [fact], now)
  store.saveSnapshot({ subjectKey: 'atlas', subject: 'Atlas', facts: [fact], citations: [], sessionId: 'a', tz: 'UTC', updatedAt: now })
  const recalled = store.recall({ userText: 'Atlas yesterday', tz: 'UTC', now })
  assert.equal(recalled.facts.length, 0)
  assert.equal(recalled.snapshots.length, 0)
  store.close()
})

test('replaying a user turn preserves its original timestamp', () => {
  const store = new MemoryStore(':memory:')
  const original = Date.parse('2026-01-01T12:00:00Z')
  store.beginTurn('a', 1, 'UTC', original)
  store.setUser('a', 1, 'Atlas', 'UTC')
  store.beginTurn('a', 1, 'UTC', original + 86400000)
  assert.equal(store.db.prepare('SELECT started_at FROM turns').get().started_at, original)
  store.close()
})

test('partial refresh retains missing baseline facts and their original dates', async () => {
  const store = new MemoryStore(':memory:')
  const deps = { store, sessionId: 'partial', turn: 1, tz: 'UTC', now: Date.parse('2026-01-01T00:00:00Z'), signal: new AbortController().signal, onAttempt() {}, maxQueries: 3 }
  const input = { queries: [{ query: 'Cursor version price', subject: 'Cursor' }], intent: 'answer' }
  writeFixtures({ '*': [result()] })
  await runSearchBatch(input, deps)
  const oldPrice = store.getSnapshot('Cursor').facts.find(f => f.attribute === 'price')
  writeFixtures({ '*': [result({ summary: 'Cursor 1.1.0 is the latest version.' })] })
  const refreshed = await runSearchBatch({ ...input, intent: 'change' }, { ...deps, now: deps.now + 86400000 })
  assert.match(refreshed.text, /Baseline.*retained/)
  assert.deepEqual(store.getSnapshot('Cursor').facts.find(f => f.attribute === 'price'), oldPrice)
  store.close()
})

test('equal price amounts with changed billing terms are not called unchanged', async () => {
  const store = new MemoryStore(':memory:')
  const deps = { store, sessionId: 'terms', turn: 1, tz: 'UTC', now: Date.now(), signal: new AbortController().signal, onAttempt() {}, maxQueries: 3 }
  const input = { queries: [{ query: 'Cursor price', subject: 'Cursor' }], intent: 'answer' }
  writeFixtures({ '*': [result()] })
  await runSearchBatch(input, deps)
  writeFixtures({ '*': [result({ summary: 'Cursor Pro costs $20 per user per year, requires annual billing.' })] })
  const refreshed = await runSearchBatch({ ...input, intent: 'change' }, deps)
  assert.match(refreshed.text, /CANNOT ESTABLISH A CHANGE/)
  store.close()
})

test('dated windows follow local calendar boundaries across daylight saving', async () => {
  const { resolveWindow } = await import('../plugin/src/memory.ts')
  const spring = resolveWindow('yesterday', 'America/New_York', Date.parse('2026-03-09T12:00:00Z'))
  assert.equal(spring.to - spring.from + 1, 23 * 3600000)
  const fall = resolveWindow('2026-11-01', 'America/New_York', Date.parse('2026-11-11T12:00:00Z'))
  assert.equal(fall.to - fall.from + 1, 25 * 3600000)
  const november = resolveWindow('this month', 'UTC', Date.parse('2026-11-11T12:00:00Z'))
  assert.equal(new Date(november.from).toISOString(), '2026-11-01T00:00:00.000Z')
})

test('compression keeps separate subjects and billing qualifiers', () => {
  const digest = buildDigest({ question: 'Cursor price', subject: 'Cursor', requireSubject: true, results: [result({ summary: 'Cursor Pro costs $20 per user per month; Windsurf Pro costs $15 per user per month. Cursor requires annual billing, minimum 20 seats.' })], budgetTokens: 300 })
  assert.ok(digest.facts.some(f => f.value === '$20'))
  assert.ok(!digest.facts.some(f => f.value === '$15'))
  assert.match(digest.block, /annual billing/)
  assert.match(digest.block, /20 seats/)
})

test('digest respects its estimated token budget even with long clauses', () => {
  const digest = buildDigest({ question: 'Atlas version', results: [result({ summary: 'Atlas version 2.0.0 provides ' + 'extensive functionality '.repeat(150) + '.' })], budgetTokens: 100 })
  assert.ok(digest.stats.digestTokens <= 100, `used ${digest.stats.digestTokens} tokens`)
  assert.equal(digest.stats.budgetExhausted, true)
})

test('comparison refuses changed seat minimums and missing billing qualifiers', () => {
  const old = parsePriceTerms('Cursor costs $20 per user per month, billed monthly. Minimum 20 seats.')[0]
  const fresh = parsePriceTerms('Cursor costs $20 per user per month, billed monthly. Minimum 50 seats.')[0]
  assert.equal(comparePriceTerms(old, fresh).status, 'incomparable')
  const unclear = parsePriceTerms('Cursor costs $20 per month.')[0]
  assert.equal(comparePriceTerms(old, unclear).status, 'incomparable')
})

test('parallel provider failure preserves supported evidence, failed baseline, and retry counts', async () => {
  const { config } = await import('../plugin/src/config.ts')
  const oldFetch = globalThis.fetch
  const oldFixtures = config.fixtures
  const oldKey = config.apiKey
  const store = new MemoryStore(':memory:')
  const saved = { subject: 'DockDesk', subjectKey: 'dockdesk', facts: [], citations: [], sessionId: 'prior', tz: 'UTC', updatedAt: 1 }
  store.saveSnapshot(saved)
  let attempts = 0
  let active = 0
  let maxActive = 0
  config.fixtures = ''
  config.apiKey = 'test-only-placeholder'
  globalThis.fetch = async (url, init) => {
    active++
    maxActive = Math.max(maxActive, active)
    try {
      await new Promise(resolve => setTimeout(resolve, 5))
      const body = JSON.parse(init.body)
      if (body.query?.includes('DockDesk')) throw new Error('simulated timeout')
      return Response.json(url.endsWith('/fetch') ? { title: 'Atlas', content: '' } : { results: [result({ title: 'Atlas', summary: 'Atlas version 2.0.0 is now available.' })] })
    } finally { active-- }
  }
  try {
    const r = await runSearchBatch({ queries: [{ query: 'Atlas version', subject: 'Atlas' }, { query: 'DockDesk version', subject: 'DockDesk' }], intent: 'change' }, { store, sessionId: 'partial', turn: 1, tz: 'UTC', now: Date.now(), signal: new AbortController().signal, onAttempt() { attempts++ }, maxQueries: 3 })
    assert.match(r.text, /Atlas/)
    assert.ok(r.facts.some(f => f.value === '2.0.0'))
    assert.ok(r.missing.some(gap => gap.includes('DockDesk')))
    assert.deepEqual(store.getSnapshot('DockDesk'), saved)
    assert.equal(r.attempts, attempts)
    assert.equal(attempts, 5)
    assert.ok(maxActive >= 2 && maxActive <= 3)
  } finally {
    globalThis.fetch = oldFetch
    config.fixtures = oldFixtures
    config.apiKey = oldKey
    store.close()
  }
})

test('unchanged version and price produce a no-change report', async () => {
  const store = new MemoryStore(':memory:')
  const deps = { store, sessionId: 'same', turn: 1, tz: 'UTC', now: Date.now(), signal: new AbortController().signal, onAttempt() {}, maxQueries: 3 }
  const input = { queries: [{ query: 'Cursor version price', subject: 'Cursor' }], intent: 'answer' }
  writeFixtures({ '*': [result()] })
  try {
    await runSearchBatch(input, deps)
    assert.match((await runSearchBatch({ ...input, intent: 'change' }, deps)).text, /No change detected/)
  } finally { store.close() }
})
