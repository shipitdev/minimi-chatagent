import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
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

const require = createRequire(import.meta.url)

// DSH parses `$...$` as inline LaTeX. Currency answers such as "$15/month ... $15 managed"
// otherwise render as italic math with spaces (and dollar signs) removed. Single-dollar
// math has no way to distinguish currency from TeX, so keep only `$$...$$` math here.
{
  const frontend = readdirSync(require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html').replace(/index\.html$/, 'assets'))
  const vendorFile = frontend.find((name) => /^vendor-.*\.js$/.test(name))
  assert(vendorFile, 'DSH web frontend vendor bundle not found')
  const vendorPath = require.resolve(`@deepseek-ai/dsh-web-frontend/dist/assets/${vendorFile}`)
  let vendor = readFileSync(vendorPath, 'utf8')
  const old = 'function Qg(e){let n={}.singleDollarTextMath;return n==null&&(n=!0)'
  const fixed = 'function Qg(e){let n=!1;return n==null&&(n=!0)'
  if (vendor.includes(old)) vendor = vendor.replace(old, fixed)
  assert(vendor.includes(fixed), 'DSH math parser changed; review the currency-rendering patch')
  writeFileSync(vendorPath, vendor)

  // Bust browser caches without renaming hashed assets. The entry script and
  // vendor preload/import all carry the same version query.
  const version = 'minimi-currency-1'
  const indexFile = frontend.find((name) => /^index-.*\.js$/.test(name))
  assert(indexFile, 'DSH web frontend entry bundle not found')
  const indexPath = require.resolve(`@deepseek-ai/dsh-web-frontend/dist/assets/${indexFile}`)
  const htmlPath = require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  let html = readFileSync(htmlPath, 'utf8')
  let indexJs = readFileSync(indexPath, 'utf8')
  const bust = (text, name) => text.replaceAll(name, `${name}?v=${version}`)
  if (!html.includes(`${indexFile}?v=`)) html = bust(html, indexFile)
  if (!html.includes(`${vendorFile}?v=`)) html = bust(html, vendorFile)
  if (!indexJs.includes(`${vendorFile}?v=`)) indexJs = bust(indexJs, vendorFile)
  writeFileSync(htmlPath, html)
  writeFileSync(indexPath, indexJs)
}

// DSH exposes brand and theme slots, but no hook for these three English strings.
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
