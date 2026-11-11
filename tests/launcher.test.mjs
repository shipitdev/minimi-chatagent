import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proxyArguments } from '../scripts/launch-config.mjs'

test('public deployment admits only its exact HTTPS hostname and keeps TLS paired', () => {
  assert.deepEqual(proxyArguments({}), [])
  assert.deepEqual(proxyArguments({ MINIMI_PUBLIC_URL: 'https://minimi.sparetokens.tech' }), ['--public-url', 'https://minimi.sparetokens.tech/', '--trusted-host', 'minimi.sparetokens.tech'])
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?token=x', 'https://example.com/#x', 'https://example.com/path']) {
    assert.throws(() => proxyArguments({ MINIMI_PUBLIC_URL: value }))
  }
  assert.throws(() => proxyArguments({ MINIMI_TLS_CERT: '/cert.pem' }))
  assert.deepEqual(proxyArguments({ MINIMI_TLS_CERT: '/cert.pem', MINIMI_TLS_KEY: '/key.pem' }), ['--tls-cert', '/cert.pem', '--tls-key', '/key.pem'])
})
