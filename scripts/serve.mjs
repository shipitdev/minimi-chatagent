/** Linux service supervisor; systemd owns restart and Cloudflare runs separately. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const root = path.resolve(import.meta.dirname, '..')
const privateDir = path.join(root, 'data/private')
const entryFile = path.join(privateDir, 'dsh-entry-url.txt')
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 })
fs.rmSync(entryFile, { force: true })
const env = {
  ...process.env,
  MINIMI_PORT: '8789',
  MINIMI_NO_OPEN: '1',
  MINIMI_DEBUG: '0',
  MINIMI_DSH_HOME: path.join(root, 'data/server-dsh'),
  MINIMI_DB: path.join(root, 'data/minimi.db'),
  MINIMI_EXTRA_PATCH: path.join(root, 'profile/review.patch.yml'),
  MINIMI_DSH_ENTRY_FILE: entryFile,
  MINIMI_GATEWAY_PORT: '8788',
  MINIMI_DSH_PORT: '8789',
}
if (!env.MINIMI_PUBLIC_URL || !env.MINIMI_TLS_CERT || !env.MINIMI_TLS_KEY) {
  throw new Error('Set MINIMI_PUBLIC_URL, MINIMI_TLS_CERT and MINIMI_TLS_KEY')
}
const children = []
let stopping = false
function stop(code) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  fs.rmSync(entryFile, { force: true })
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL') }, 5000).unref()
}
for (const [name, script] of [['app', 'scripts/dev.mjs'], ['gateway', 'scripts/public-gateway.mjs']]) {
  const child = spawn(process.execPath, [path.join(root, script)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', line => {
      const match = /dsh web:\s+(https:\/\/\S+)/.exec(line)
      if (match) {
        if (!stopping) fs.writeFileSync(entryFile, match[1] + '\n', { mode: 0o600 })
        console.log('[app] private entry ready')
      } else console.log(`[${name}] ${line.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')}`)
    })
  }
  child.on('error', error => { console.error(`[${name}] ${error.message}`); stop(1) })
  child.on('exit', code => { if (!stopping) stop(code || 1) })
}
process.on('SIGTERM', () => stop(0))
process.on('SIGINT', () => stop(0))
process.on('exit', () => fs.rmSync(entryFile, { force: true }))
