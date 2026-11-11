import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createGateway } from '../scripts/public-gateway.mjs'

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function mockDsh() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/?token=test-token')) {
        res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-test=valid; Path=/; HttpOnly; SameSite=Strict' })
        res.end()
        return
      }
      if (req.url === '/' && /dsh-auth-test=valid/.test(String(req.headers.cookie ?? ''))) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<h1>MINIMI_APP</h1>')
        return
      }
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('public gateway exchanges DSH auth and proxies the app without exposing the token', async () => {
  const upstream = await mockDsh()
  const port = await freePort()
  const publicUrl = `http://127.0.0.1:${port}`
  const gateway = createGateway({
    publicUrl,
    dshPort: upstream.port,
    dshTls: false,
    entryUrl: `${publicUrl}/?token=test-token`,
    accessKey: '',
    log: () => {},
  })
  await gateway.listen(port)
  try {
    const root = await fetch(`${publicUrl}/`, { redirect: 'manual' })
    assert.equal(root.status, 302)
    assert.match(root.headers.get('location') ?? '', /^\/__minimi\/unlock/)

    const unlock = await fetch(`${publicUrl}/__minimi/unlock?next=%2F`, { redirect: 'manual' })
    assert.equal(unlock.status, 302)
    assert.equal(unlock.headers.get('location'), '/')
    const cookie = unlock.headers.get('set-cookie') ?? ''
    assert.match(cookie, /dsh-auth-test=valid/)
    assert.doesNotMatch(cookie, /test-token/)

    const app = await fetch(`${publicUrl}/`, { headers: { cookie }, redirect: 'manual' })
    assert.equal(app.status, 200)
    assert.match(await app.text(), /MINIMI_APP/)
    assert.doesNotMatch(await (await fetch(`${publicUrl}/__minimi/health`)).text(), /test-token/)
  } finally {
    await gateway.close()
    await closeServer(upstream.server)
  }
})

test('optional access key gates the exchange and rejects a wrong key', async () => {
  const upstream = await mockDsh()
  const port = await freePort()
  const publicUrl = `http://127.0.0.1:${port}`
  const gateway = createGateway({
    publicUrl,
    dshPort: upstream.port,
    dshTls: false,
    entryUrl: `${publicUrl}/?token=test-token`,
    accessKey: 'let-me-in',
    log: () => {},
  })
  await gateway.listen(port)
  try {
    const page = await fetch(`${publicUrl}/__minimi/unlock`, { redirect: 'manual' })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Access key/)

    const wrong = await fetch(`${publicUrl}/__minimi/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'key=nope&next=%2F',
    })
    assert.equal(wrong.status, 401)

    const ok = await fetch(`${publicUrl}/__minimi/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'key=let-me-in&next=%2F',
    })
    assert.equal(ok.status, 302)
    assert.match(ok.headers.get('set-cookie') ?? '', /dsh-auth-test=valid/)
  } finally {
    await gateway.close()
    await closeServer(upstream.server)
  }
})
