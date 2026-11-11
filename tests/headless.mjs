#!/usr/bin/env node
/**
 * Live-model acceptance on the DSH headless surface.
 * This is the same Minimi plugin and the same DSH loop as the browser, without
 * a browser. It requires DEEPSEEK_API_KEY in .env.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minimi-headless-'))
const db = path.join(tmp, 'headless.db')
const dshBin = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const patch = path.join(root, 'profile', 'headless.patch.yml')
const env = { ...process.env, DSH_HOME: path.join(root, '.dsh'), MINIMI_DB: db, MINIMI_DEBUG: '1' }
delete env.MINIMI_SEARCH_FIXTURES

function run(prompt, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dshBin, '--profile', 'headless', '--patch', patch, prompt], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`timed out after ${timeoutMs}ms\n${out}\n${err}`))
    }, timeoutMs)
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`dsh exited ${code}\n${out}\n${err}`))
      else resolve({ out, err })
    })
  })
}

function audit() {
  return JSON.parse(fs.readFileSync(path.join(root, 'data', 'tool-boundary.json'), 'utf8'))
}

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

console.log(`[headless] db=${db}`)
let r = await run('Please remember this for later: project Atlas uses PostgreSQL 17, and its target release date is 2027-03-15. Reply in one sentence.')
check('memory turn stores the dated fact', () => {
  assert.match(r.out, /Atlas|PostgreSQL|remembered|Noted/i)
  const a = audit()
  assert.deepEqual(a.visible, ['web_search'], `expected only web_search, got ${a.visible.join(', ')}`)
  assert.equal(a.disabledProbe.bash, false)
  assert.equal(a.disabledProbe.read_file, false)
})

// New process, new DSH session, same SQLite memory.
r = await run('What database does project Atlas use, and what is its target release date? Answer from memory.')
check('dated recall after process restart', () => {
  assert.match(r.out, /PostgreSQL 17/i)
  assert.match(r.out, /2027-03-15|March 15, 2027|15 March 2027/i)
})

r = await run('Use web_search to find the latest Node.js LTS release and answer in one sentence with a clickable source link.')
check('live search returns a cited answer', () => {
  assert.match(r.out, /https?:\/\//)
  assert.match(r.out, /\[S\d+\]\(https?:\/\//)
  assert.match(r.out, /Node\.js|Node 2\d|LTS/i)
})

/** Change detection is deterministic; the headless model is asked to request it. */
r = await run('Use web_search with intent "change" and subject "DeepSeek V4" to check what changed. Give a short answer; if no baseline exists, say this is the first observation.')
check('change check reaches the deterministic diff path or records a baseline', () => {
  assert.match(r.out, /change|baseline|first observation|no change|observation/i)
})

const failed = results.filter((x) => !x.ok)
console.log(`\n[headless] ${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
