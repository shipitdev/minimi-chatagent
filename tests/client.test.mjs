import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const React = { createElement: (type, props, ...children) => ({ type, props, children }) }

function luminance(hex) {
  const c = hex.slice(1).match(/../g).map(n => parseInt(n, 16) / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
}

test('client brand registers through supported slots and supplies readable light/dark colors', () => {
  let plugin
  const document = { title: 'DSH' }
  const cleanups = []
  const slots = new Map()
  let palette
  let disposed = false
  vm.runInNewContext(fs.readFileSync(new URL('../client/lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: mod => { plugin = mod.factory(() => React) } } },
    document, setInterval, clearInterval,
  })
  const ctx = {
    effect(fn) { cleanups.push(fn()) },
    theme: { overrideTokens(source, tokens) { assert.equal(source, 'minimi'); palette = tokens; return () => { disposed = true } } },
    slots: {
      inject(name, fn) { const result = fn(); if (result?.next) for (const _ of result) {} },
      register({ name }, Component) { slots.set(name, Component) },
    },
  }
  try {
    plugin.apply(ctx)
    assert.equal(document.title, 'Minimi')
    assert.equal(slots.get('sidebar.brand.mark')({}).props['aria-label'], 'Minimi')
    assert.equal(slots.get('sidebar.brand.name')().children[0], 'Minimi')
    assert.equal(slots.get('sidebar.brand.name')().children[1].children[0], 'research')
    for (const mode of ['light', 'dark']) {
      const bg = luminance(palette['--dsw-alias-bg-base'][mode])
      const link = luminance(palette['--dsw-alias-link'][mode])
      assert.ok((Math.max(bg, link) + 0.05) / (Math.min(bg, link) + 0.05) >= 4.5, `${mode} link contrast`)
    }
  } finally { for (const cleanup of cleanups.reverse()) cleanup?.() }
  assert.equal(disposed, true)
})
