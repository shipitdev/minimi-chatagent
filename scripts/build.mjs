import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

mkdirSync('plugin/lib', { recursive: true })
await build({
  entryPoints: ['plugin/src/index.ts'],
  outfile: 'plugin/lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['node:*'],
  sourcemap: false,
  logLevel: 'info',
})

// DSH exposes brand and theme slots, but no hook for these three English strings.
const require = createRequire(import.meta.url)
const conversation = require.resolve('@deepseek-ai/dsh-client-ui-conversation/client')
let client = readFileSync(conversation, 'utf8')
for (const [before, after] of [
  ['"hero.headline": "Into the Unknown"', '"hero.headline": "A little clarity."'],
  ['"placeholder.hero": "Describe what you want to build, / commands, @ files or sessions"', '"placeholder.hero": "Ask a question, explore an idea, or pick up where we left off"'],
  ['"placeholder.default": "Message or run a task, / commands, @ files or sessions"', '"placeholder.default": "Ask Minimi · research, write, remember"'],
]) {
  assert(client.includes(before) || client.includes(after), 'DSH copy changed; review the Minimi text patch')
  client = client.replace(before, after)
}
writeFileSync(conversation, client)
