#!/usr/bin/env node
/**
 * Minimi launcher.
 *
 * Owns the project-local DSH_HOME, the web profile overlay, and the port. DSH
 * itself owns the agent loop, model calls, sessions, and the browser UI.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { proxyArguments } from './launch-config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

const port = Number(process.env.MINIMI_PORT ?? process.env.PORT ?? 8787)
const noOpen = process.env.MINIMI_NO_OPEN === '1' || process.argv.includes('--no-open')
const profile = process.env.MINIMI_PROFILE ?? 'web'
const patchFile = path.join(root, 'profile', 'web.patch.yml')
const dshHome = path.resolve(root, process.env.MINIMI_DSH_HOME ?? '.dsh')
const publicArgs = proxyArguments(process.env)
const dshBin = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

if (!fs.existsSync(dshBin)) {
  console.error('DSH is not installed. Run `npm install` first.')
  process.exit(1)
}
if (!fs.existsSync(patchFile)) {
  console.error(`Missing profile overlay: ${patchFile}`)
  process.exit(1)
}

fs.mkdirSync(path.join(root, 'data'), { recursive: true })

console.log('[minimi] building host plugin…')
const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
})
if (build.status !== 0) process.exit(build.status ?? 1)

const args = [
  dshBin,
  '--profile', profile,
  '--patch', patchFile,
  ...(process.env.MINIMI_EXTRA_PATCH ? ['--patch', path.resolve(root, process.env.MINIMI_EXTRA_PATCH)] : []),
  '--port', String(port),
]
if (noOpen) args.push('--no-open')
args.push(...publicArgs)

const env = {
  ...process.env,
  DSH_HOME: dshHome,
  MINIMI_DB: path.resolve(root, process.env.MINIMI_DB ?? 'data/minimi.db'),
}

console.log(`[minimi] DSH_HOME=${dshHome}`)
console.log(`[minimi] profile=${profile}  port=${port}  open=${!noOpen}`)
console.log('[minimi] waiting for the DSH web URL line…')

const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
const forward = (signal) => {
  if (!child.killed) child.kill(signal)
}
process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))
child.on('exit', (code, signal) => {
  process.exit(signal ? 0 : (code ?? 0))
})
