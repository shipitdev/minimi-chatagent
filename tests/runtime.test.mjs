import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minimi-runtime-'))
process.env.MINIMI_DB = path.join(tmp, 'runtime.db')
process.env.MINIMI_SEARCH_FIXTURES = tmp
fs.writeFileSync(path.join(tmp, 'search.json'), JSON.stringify({ '*': [{ title: 'Atlas', url: 'https://example.com/atlas', summary: 'Atlas version 2.0.0 is now available.', authority: 4 }] }))
fs.writeFileSync(path.join(tmp, 'fetch.json'), JSON.stringify({ '*': { title: 'Atlas', content: '' } }))
const plugin = await import('../plugin/src/index.ts')

test('Minimi registers only web_search; native DSH dispatch rejects forged stock tools', async () => {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() {}, context() {} })
  ctx.provide('agents', { turnBoundaryOf: () => ({ lastTurn: 1 }) })
  const registry = ctx.plugin(ToolsService)
  await new Promise(resolve => setTimeout(resolve, 0))
  const minimi = ctx.plugin(plugin)
  await new Promise(resolve => setTimeout(resolve, 0))
  try {
    ctx.tools.setExecutor(new NativeToolExecutor(ctx))
    assert.deepEqual(ctx.tools.schemas().map(t => t.name), ['web_search'])
    const result = await ctx.tools.execute({
      calls: ['bash', 'web_fetch', 'write', 'subagent'].map(name => ({ type: 'tool-call', id: name, name, arguments: '{}' })),
      signal: new AbortController().signal,
    })
    for (const { result: outcome } of result.results) {
      assert.equal(outcome.isError, true)
      assert.equal(outcome.error.info.code, 'UNKNOWN_TOOL')
    }
    const search = ctx.tools.get('web_search')
    const exec = { agent: { session: { header: { id: 'budget-test' } } }, signal: new AbortController().signal }
    const args = { queries: [{ query: 'Atlas version', subject: 'Atlas' }] }
    const first = await search.execute(args, exec)
    assert.match(first.text, /provider attempts 2\/12/)
    const second = await search.execute(args, exec)
    assert.match(second.text, /provider attempts 4\/12/)
    const third = await search.execute(args, exec)
    assert.match(third.text, /SEARCH_BUDGET_EXCEEDED/)
  } finally {
    await minimi.dispose()
    await registry.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
