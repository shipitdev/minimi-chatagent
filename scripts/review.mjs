import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'

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
const privateDir = path.join(root, 'data/private')
const token = path.join(privateDir, 'cloudflared-token')
const connector = path.join(root, 'data/bin/cloudflared')
const pidFile = path.join(privateDir, 'review.pid')
const entryFile = path.join(privateDir, 'dsh-entry-url.txt')
const accessKeyFile = path.join(privateDir, 'access-key')
if (fs.existsSync(pidFile)) {
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Invalid reviewer PID file')
  try { process.kill(pid, 0); throw new Error('Reviewer demo is already running') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('The reviewer demo requires Node 24.9+')
for (const file of [token, connector, path.join(privateDir, 'origin-cert.pem'), path.join(privateDir, 'origin-key.pem')]) {
  if (!fs.existsSync(file)) throw new Error(`Missing deployment prerequisite: ${file}`)
}
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 })
fs.rmSync(path.join(privateDir, 'reviewer-url.txt'), { force: true })
fs.rmSync(entryFile, { force: true })
const accessKey = process.env.MINIMI_ACCESS_KEY || (fs.existsSync(accessKeyFile) ? fs.readFileSync(accessKeyFile, 'utf8').trim() : '')
const env = {
  ...process.env,
  MINIMI_PORT: '8789',
  MINIMI_NO_OPEN: '1',
  MINIMI_DEBUG: '0',
  MINIMI_DSH_HOME: path.join(root, 'data/review-dsh'),
  MINIMI_DB: path.join(root, 'data/review.db'),
  MINIMI_EXTRA_PATCH: path.join(root, 'profile/review.patch.yml'),
  MINIMI_PUBLIC_URL: 'https://minimi.sparetokens.tech',
  MINIMI_TLS_CERT: path.join(privateDir, 'origin-cert.pem'),
  MINIMI_TLS_KEY: path.join(privateDir, 'origin-key.pem'),
  MINIMI_ACCESS_KEY: accessKey,
}
const app = spawn(process.execPath, [path.join(root, 'scripts/dev.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
const gateway = spawn(process.execPath, [path.join(root, 'scripts/public-gateway.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    MINIMI_PUBLIC_URL: 'https://minimi.sparetokens.tech',
    MINIMI_GATEWAY_PORT: '8788',
    MINIMI_DSH_PORT: '8789',
    MINIMI_TLS_CERT: path.join(privateDir, 'origin-cert.pem'),
    MINIMI_TLS_KEY: path.join(privateDir, 'origin-key.pem'),
    MINIMI_DSH_ENTRY_FILE: entryFile,
    MINIMI_ACCESS_KEY: accessKey,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const tunnel = spawn(connector, ['--no-autoupdate', 'tunnel', '--protocol', 'http2', 'run', '--token-file', token], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
const awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
const trace = spawn(process.execPath, [path.join(root, 'evals/observability-export.mjs'), '--watch'], {
  cwd: root,
  env: { ...process.env, MINIMI_OBSERVABILITY_FILE: path.join(root, 'data/observability/turns.jsonl') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const children = [app, gateway, tunnel, trace, awake]
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL') }, 5000).unref()
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
for (const [name, child] of [['app', app], ['gateway', gateway], ['tunnel', tunnel], ['trace', trace]]) {
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', line => {
      const match = /dsh web:\s+(https:\/\/\S+)/.exec(line)
      if (match) {
        fs.writeFileSync(path.join(privateDir, 'reviewer-url.txt'), match[1] + '\n', { mode: 0o600 })
        fs.writeFileSync(entryFile, match[1] + '\n', { mode: 0o600 })
        console.log('[app] Private sign-in link saved to data/private/reviewer-url.txt')
        console.log('[app] Public gateway entry file saved')
      } else console.log(`[${name}] ${line.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')}`)
    })
  }
  child.on('error', error => { console.error(`[${name}] ${error.message}`); process.exitCode = 1; stop() })
  child.on('exit', code => {
    if (name === 'trace') { if (!stopping) console.log(`[trace] exporter exited (${code})`) ; return }
    if (!stopping) { process.exitCode = code || 1; stop() }
  })
}
fs.writeFileSync(pidFile, String(process.pid) + '\n', { mode: 0o600 })
process.on('exit', () => {
  fs.rmSync(pidFile, { force: true })
  fs.rmSync(entryFile, { force: true })
  fs.rmSync(path.join(privateDir, 'reviewer-url.txt'), { force: true })
})
