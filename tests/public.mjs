import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { DatabaseSync } from 'node:sqlite'

const root = path.resolve(import.meta.dirname, '..')
const envFile = path.join(root, '.env')
if (fs.existsSync(envFile)) {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile)
  else {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  }
}
const publicUrl = process.env.MINIMI_PUBLIC_URL || 'https://minimi.sparetokens.tech'
const accessKeyFile = path.join(root, 'data/private/access-key')
const accessKey = process.env.MINIMI_ACCESS_KEY || (fs.existsSync(accessKeyFile) ? fs.readFileSync(accessKeyFile, 'utf8').trim() : '')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: process.env.MINIMI_TEST_COLOR_SCHEME ?? 'light' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const publicEntry = await fetch(publicUrl, { redirect: 'manual' })
  assert.ok([200, 302].includes(publicEntry.status), `public entry must not require the private DSH link (got ${publicEntry.status})`)
  assert.notEqual(publicEntry.status, 401)
  await page.goto(publicUrl, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(1000)
  const keyField = page.locator('input[name="key"]')
  if (await keyField.count()) {
    assert.ok(accessKey, 'the public gateway requires a key, but no MINIMI_ACCESS_KEY or data/private/access-key is available')
    await keyField.fill(accessKey)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.waitForLoadState('networkidle', { timeout: 60000 })
    await page.waitForTimeout(1000)
  }
  const notice = page.getByRole('button', { name: 'Continue', exact: true })
  if (await notice.count()) await notice.click()
  await page.waitForTimeout(500)
  const body = await page.locator('body').innerText()
  assert.equal(await page.title(), 'Minimi')
  for (const label of [/^Plugins$/, /^More$/, /Account menu/, /^Settings$/]) {
    assert.equal(await page.getByRole('button', { name: label }).count(), 0, `public UI must not expose ${label}`)
  }
  assert.doesNotMatch(body, /Plugins|Automation tasks|Workspace Write|Settings/)
  await page.screenshot({ path: path.join(root, 'data/public-home.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(800)
  const collapse = page.getByRole('button', { name: /Collapse sidebar/i }).first()
  if (await collapse.isVisible()) await collapse.click()
  await page.screenshot({ path: path.join(root, 'data/public-mobile.png') })
  assert.ok(await page.locator('[contenteditable="true"]').first().isVisible(), 'mobile composer is visible')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.waitForTimeout(500)
  assert.equal(page.url(), new URL(publicUrl).origin + '/')
  const cookies = await context.cookies()
  assert.ok(cookies.some(c => c.secure && c.httpOnly), 'the public sign-in cookie must be secure and HttpOnly')
  console.log('PASS public URL access, optional key, secure cookie, and chat-only Minimi UI')
  const db = new DatabaseSync(path.join(root, 'data/review.db'))
  const countSearches = () => db.prepare('SELECT COUNT(*) AS n FROM searches').get().n
  const send = async prompt => {
    const before = await page.locator('[data-turn-tail]').count()
    const box = page.locator('[contenteditable="true"]').first()
    await box.fill(prompt)
    await box.press('Enter')
    await page.waitForFunction(before => document.querySelectorAll('[data-turn-tail]').length > before, before, { timeout: 180000 })
    await page.waitForTimeout(500)
    return page.locator('[data-chat-group-part="response"]').last().innerText()
  }
  try {
    if (!process.argv.includes('--smoke')) await page.getByRole('button', { name: /New Session/i }).first().click()
    if (process.argv.includes('--smoke')) {
      console.log('PASS public desktop/mobile layout smoke check')
    } else if (process.argv.includes('--recall')) {
      const before = countSearches()
      const answer = await send('What database and target release date did I tell you for project Atlas? Answer from memory.')
      assert.match(answer, /PostgreSQL 17/i)
      assert.match(answer, /2027-03-15|March 15, 2027|15 March 2027/i)
      assert.equal(countSearches(), before)
      await page.screenshot({ path: path.join(root, 'data/public-recall.png') })
      console.log('PASS public dated recall in a new session after restart, zero search')
    } else {
      const before = countSearches()
      assert.match(await send('What is 17 * 23? Reply with only the number.'), /391/)
      assert.equal(countSearches(), before)
      console.log('PASS public live-model arithmetic, zero search')
      await send('Remember: project Atlas uses PostgreSQL 17 and its target release date is 2027-03-15.')
      const remembered = db.prepare('SELECT * FROM turns WHERE user_text LIKE ?').get('%project Atlas uses PostgreSQL 17%')
      assert.ok(remembered?.assistant_text)
      console.log('PASS public memory turn persisted')
      const answer = await send('Use web_search to check the latest Node.js LTS version from official sources. Cite the release with clickable source links.')
      const links = await page.locator('[data-chat-group-part="response"]').last().locator('a[href^="http"]').evaluateAll(as => as.map(a => a.href))
      const evidence = new Set(db.prepare('SELECT citations FROM searches').all().flatMap(r => JSON.parse(r.citations).map(c => c.url)))
      assert.match(answer, /Node|LTS/i)
      assert.ok(links.some(url => evidence.has(url)), 'final answer must link to tool evidence')
      assert.ok(countSearches() > before)
      await page.screenshot({ path: path.join(root, 'data/public-search.png') })
      console.log('PASS public live web_search turn and clickable evidence links')
    }
    assert.deepEqual(errors, [])
    console.log('PASS no browser page errors')
  } finally { db.close() }
} finally { await browser.close() }
