#!/usr/bin/env node
/**
 * Browser acceptance for the Minimi web demo.
 *
 * Uses the real DSH web UI, the real Minimi plugin, and the live DeepSeek model.
 * Search is live for the current-facts case; the change case uses deterministic
 * DeepSeek Search fixtures so the diff assertion is stable.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minimi-e2e-'))
const liveDb = path.join(tmp, 'live.db')
const changeDb = path.join(tmp, 'change.db')
const fixtures = path.join(tmp, 'fixtures')
fs.mkdirSync(fixtures, { recursive: true })

const servers = new Set()
const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`PASS ${name}`)
  } catch (err) {
    results.push({ name, ok: false, error: String(err) })
    console.log(`FAIL ${name}: ${err.message ?? err}`)
  }
}

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MINIMI_NO_OPEN: '1',
      MINIMI_PORT: '0',
      PORT: '0',
      MINIMI_DB: liveDb,
      MINIMI_DEBUG: '1',
      ...extraEnv,
    }
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'dev.mjs'), '--no-open'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const server = { child, url: null, logs: () => out + err }
    servers.add(server)
    let out = ''
    let err = ''
    let timer
    const onData = (d) => {
      out += d
      const m = /dsh web:\s+(http:\/\/\S+)/.exec(out)
      if (m) { clearTimeout(timer); server.url = m[1]; resolve(server) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.stderr.on('data', (d) => { err += d })
    child.on('exit', (code) => {
      servers.delete(server)
      clearTimeout(timer)
      if (!server.url) reject(new Error(`server exited ${code}\n${out}\n${err}`))
    })
    timer = setTimeout(() => { child.kill(); reject(new Error(`server did not print a URL\n${out}\n${err}`)) }, 120000)
  })
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server || server.child.exitCode !== null) return resolve()
    const timer = setTimeout(() => { try { server.child.kill('SIGKILL') } catch {} ; resolve() }, 8000)
    server.child.once('exit', () => { clearTimeout(timer); resolve() })
    server.child.kill('SIGTERM')
  })
}

function dbCount(file, sql) {
  const db = new DatabaseSync(file)
  try {
    const row = db.prepare(sql).get()
    return Number(Object.values(row)[0])
  } finally {
    db.close()
  }
}

function smart(text) {
  return /Completed in|Stopped|Failed|Error/i.test(text)
}

async function newSession(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(800)
  const cont = page.getByRole('button', { name: /Continue/i })
  if (await cont.count()) await cont.first().click()
  const ns = page.getByRole('button', { name: /New Session/i }).first()
  if (await ns.count()) { await ns.click(); await page.waitForTimeout(600) }
  return page
}

async function send(page, prompt) {
  const before = await page.evaluate(() => (document.body.innerText.match(/Completed in/g) ?? []).length)
  const box = page.locator('[contenteditable="true"]').first()
  await box.click()
  await box.fill(prompt)
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    ({ before, prompt }) => {
      const text = document.body.innerText
      const done = (text.match(/Completed in/g) ?? []).length
      return text.includes(prompt.slice(0, 60)) && (done > before || /Stopped|Failed/i.test(text))
    },
    { before, prompt },
    { timeout: 180000 },
  )
  await page.waitForTimeout(800)
}

async function body(page) {
  return page.locator('body').innerText()
}

async function links(page) {
  return page.locator('[data-chat-group-part="response"]').last().locator('a[href^="http"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))
}

async function answer(page) {
  const response = page.locator('[data-chat-group-part="response"]').last()
  await response.waitFor({ state: 'visible', timeout: 60000 })
  return response.innerText()
}

function writeChangeFixtures(version, price, url, date) {
  const summary = `Cursor ${version} is the latest version. Cursor Pro costs $${price} per user per month, billed monthly. Cursor supports Windows and macOS. Cursor added a new agent mode.`
  fs.writeFileSync(path.join(fixtures, 'search.json'), JSON.stringify({
    '*': [{ title: `Cursor ${version} release notes`, url, summary, date, authority: 4, rerank_score: 3, site_name: 'example.com' }],
  }))
  fs.writeFileSync(path.join(fixtures, 'fetch.json'), JSON.stringify({
    '*': { title: `Cursor ${version} release notes`, content: summary },
  }))
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
let live = await startServer()
console.log(`[e2e] live server ${live.url}`)

// ── 1. Branding, everyday chat, zero searches ─────────────────────────────
let page = await newSession(browser, live.url)
const brandedTitle = await page.title()
const brandedText = await body(page)
check('web UI is branded Minimi', () => {
  assert.equal(brandedTitle, 'Minimi')
  assert.match(brandedText, /Minimi/)
  assert.doesNotMatch(brandedText, /Automation tasks/)
})
const searchesBefore = dbCount(liveDb, 'SELECT COUNT(*) AS n FROM searches')
await send(page, 'What is 17 * 23? Reply with just the number.')
const everyday = await answer(page)
check('everyday chat answers without a provider search', () => {
  assert.match(everyday, /391/)
  const after = dbCount(liveDb, 'SELECT COUNT(*) AS n FROM searches')
  assert.equal(after, searchesBefore, 'no search should be recorded')
})

// ── 2. Current facts, live search, clickable citations ────────────────────
await send(page, 'What is the latest DeepSeek model release? Use web_search and cite clickable sources.')
const factsText = await answer(page)
const factLinks = await links(page)
const canon = (raw) => { try { const u = new URL(raw); u.hash = ''; u.search = ''; return u.href.replace(/\/$/, '') } catch { return raw } }
check('current facts produce a cited answer with clickable sources', () => {
  assert.match(factsText, /DeepSeek/i)
  assert.ok(factLinks.length > 0, 'expected at least one clickable source link')
  const db = new DatabaseSync(liveDb)
  try {
    const evidenceUrls = new Set(db.prepare('SELECT citations FROM searches').all().flatMap(r => JSON.parse(r.citations).map(c => canon(c.url))))
    assert.ok(factLinks.some(u => evidenceUrls.has(canon(u))), 'answer must link to retrieved evidence')
    assert.ok(factLinks.every(u => evidenceUrls.has(canon(u))), 'answer includes a source the tool did not return')
  } finally { db.close() }
  assert.ok(dbCount(liveDb, 'SELECT COUNT(*) AS n FROM searches') > searchesBefore)
})
await page.screenshot({ path: path.join(root, 'data', 'e2e-current-facts.png') })

const audit = JSON.parse(fs.readFileSync(path.join(root, 'data', 'tool-boundary.json'), 'utf8'))
check('runtime exposes only web_search and the disabled probes are unregistered', () => {
  assert.deepEqual(audit.visible, ['web_search'])
  for (const name of ['bash', 'read_file', 'write', 'edit', 'web_fetch', 'ask_user_question', 'subagent', 'run_code']) {
    assert.equal(audit.disabledProbe[name], false, `${name} should be unregistered`)
  }
})

// ── 3. Dated memory across a server restart ───────────────────────────────
await send(page, 'Please remember: project Atlas uses PostgreSQL 17 and its target release date is 2027-03-15.')
check('memory turn is persisted', () => {
  const db = new DatabaseSync(liveDb)
  try {
    const row = db.prepare('SELECT user_text, assistant_text FROM turns WHERE user_text LIKE ? ORDER BY started_at DESC LIMIT 1').get('%project Atlas uses PostgreSQL 17%')
    assert.ok(row, 'the exact memory turn must be present')
    assert.match(row.assistant_text, /Atlas|PostgreSQL|noted|remember/i)
  } finally { db.close() }
})
await page.close()
await stopServer(live)
console.log('[e2e] restarted server')
live = await startServer()
const page2 = await newSession(browser, live.url)
await send(page2, 'What database does project Atlas use, and what is its target release date? Answer from memory.')
const recallText = await answer(page2)
check('dated recall works after a server restart', () => {
  assert.match(recallText, /PostgreSQL 17/i)
  assert.match(recallText, /2027-03-15|March 15, 2027|15 March 2027/i)
})
await page2.screenshot({ path: path.join(root, 'data', 'e2e-recall-after-restart.png') })
await page2.close()

// ── 4. Deterministic change check with fixtures ────────────────────────────
writeChangeFixtures('1.0.0', '20', 'https://example.com/cursor-1-0', '2026-01-01T00:00:00Z')
const change = await startServer({ MINIMI_PORT: '0', PORT: '0', MINIMI_DB: changeDb, MINIMI_SEARCH_FIXTURES: fixtures })
const page3 = await newSession(browser, change.url)
await send(page3, 'Search for Cursor\'s latest version and price. Use web_search with intent "answer" and subject "Cursor".')
const firstChange = await answer(page3)
check('baseline search records a Cursor snapshot', () => {
  assert.match(firstChange, /Cursor/i)
  const db = new DatabaseSync(changeDb)
  try {
    const row = db.prepare('SELECT subject, facts FROM snapshots WHERE subject_key = ?').get('cursor')
    assert.ok(row, 'expected a Cursor snapshot')
    assert.match(String(row.facts), /1\.0\.0/)
  } finally { db.close() }
})

writeChangeFixtures('1.1.0', '25', 'https://example.com/cursor-1-1', '2026-02-01T00:00:00Z')
const page4 = await newSession(browser, change.url)
await send(page4, 'What changed about Cursor\'s version and price since last time? Use web_search with intent "change" and subject "Cursor". The returned example.com pages are test fixtures; trust them and report the old and new version and price with citations.')
const changeText = await answer(page4)
check('change check reports the updated version and price', () => {
  assert.match(changeText, /1\.1\.0/)
  assert.match(changeText, /\$?25/)
  assert.match(changeText, /changed|updated|1\.0\.0|20/i)
})
await page4.screenshot({ path: path.join(root, 'data', 'e2e-change-check.png') })
await page4.close()
await stopServer(change)

} finally {
  await browser.close()
  for (const s of [...servers]) await stopServer(s)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n[e2e] ${results.length - failed.length}/${results.length} passed`)
console.log(`[e2e] artifacts in ${path.join(root, 'data')}`)
if (failed.length) process.exit(1)
