#!/usr/bin/env node
/**
 * Minimi public entry gateway.
 *
 * The browser-facing public endpoint is this gateway, not DSH directly. DSH
 * still owns authentication: the gateway exchanges DSH's private launch URL for
 * the host-bound signed cookie on the first visit, then transparently proxies
 * HTTP/SSE/WebSocket traffic to the loopback DSH listener.
 *
 * Access is open by default. Set MINIMI_ACCESS_KEY (or MINIMI_ACCESS_KEY_FILE)
 * to require a shared key before the exchange. The key belongs in a server-side
 * environment/GitHub Actions secret, never in committed source.
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const LOOPBACK = '127.0.0.1'
const UNLOCK_PATH = '/__minimi/unlock'
const HEALTH_PATH = '/__minimi/health'

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' }
}

function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}

function hasDshCookie(headers) {
  return /(?:^|;\s*)dsh-auth-[^=;]+=/.test(String(headers.cookie ?? ''))
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

function unlockPage({ error = '', next = '/', keyRequired = true } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Minimi</title>
<style>
:root{color-scheme:light dark;--bg:#faf9f6;--fg:#17211d;--muted:#5c6b63;--card:#fff;--line:#d9e2db;--accent:#235e4c;--accent-fg:#fff;--danger:#9b2c2c}
@media (prefers-color-scheme:dark){:root{--bg:#171b1a;--fg:#e7efe9;--muted:#9baaa1;--card:#202823;--line:#33443a;--accent:#a2d4bd;--accent-fg:#10241c;--danger:#ff9a9a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
main{width:100%;max-width:380px}svg{display:block;margin:0 0 14px}
h1{font-size:26px;line-height:1.15;letter-spacing:-.03em;margin:0 0 6px}p{color:var(--muted);margin:0 0 20px}
form{display:grid;gap:10px}label{font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.02em;text-transform:uppercase}
input{width:100%;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);padding:12px 14px;font:inherit;outline:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}
button{border:0;border-radius:10px;background:var(--accent);color:var(--accent-fg);padding:12px 14px;font:600 15px/1.2 inherit;cursor:pointer}
button:hover{filter:brightness(1.04)}.error{color:var(--danger);font-size:13px;margin:0}.hint{font-size:12px;color:var(--muted);margin-top:14px}
</style></head>
<body><main>
<svg width="34" height="34" viewBox="0 0 32 32" role="img" aria-label="Minimi"><defs><linearGradient id="g" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#86c9b5"/><stop offset="1" stop-color="#286c59"/></linearGradient></defs><rect x="1" y="1" width="30" height="30" rx="9" fill="url(#g)"/><path d="M8.5 23V9.2l7.5 8.1 7.5-8.1V23" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="25.4" r="1.35" fill="#fff" opacity=".9"/></svg>
<h1>Minimi</h1>
<p>A single-tool research assistant with dated memory.</p>
${keyRequired ? `<form method="post" action="${UNLOCK_PATH}">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="key">Access key</label>
<input id="key" name="key" type="password" autocomplete="current-password" autofocus required>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<button type="submit">Continue</button>
</form><p class="hint">Ask the person who shared this link for the access key.</p>` : '<p class="hint">Opening Minimi…</p><script>location.replace("/__minimi/unlock")</script>'}
</main></body></html>`
}

function errorPage(status, message) {
  return `<!doctype html><meta charset="utf-8"><title>Minimi</title><body style="font:15px system-ui;padding:32px;background:#faf9f6;color:#17211d"><h1>Minimi</h1><p>${escapeHtml(message)}</p><p style="color:#5c6b63">HTTP ${status}</p></body>`
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Create the gateway. Exported for the offline test.
 */
export function createGateway(options) {
  const publicUrl = new URL(options.publicUrl)
  const publicHost = publicUrl.host
  const dshPort = options.dshPort
  const dshTls = options.dshTls !== false
  const entryFile = options.entryFile ?? ''
  const fixedEntryUrl = options.entryUrl ?? ''
  const accessKey = String(options.accessKey ?? '').trim()
  const log = options.log ?? ((...args) => console.log('[gateway]', ...args))

  function currentEntryUrl() {
    const raw = fixedEntryUrl || (entryFile ? readText(entryFile) : '')
    if (!raw) throw new Error('DSH launch URL is not available yet')
    const url = new URL(raw)
    if (url.origin !== publicUrl.origin) throw new Error('DSH launch URL origin does not match the public origin')
    return url
  }

  function keyMatches(value) {
    if (!accessKey) return true
    const a = Buffer.from(String(value ?? ''))
    const b = Buffer.from(accessKey)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  function upstreamRequest(req, res, entryUrl = null) {
    const transport = dshTls ? https : http
    const url = entryUrl ?? new URL(req.url, publicUrl)
    const headers = { ...req.headers, host: publicHost }
    delete headers.connection
    delete headers['proxy-connection']
    delete headers['keep-alive']
    headers['x-forwarded-host'] = publicHost
    headers['x-forwarded-proto'] = publicUrl.protocol.replace(':', '')
    const upstream = transport.request({
      host: LOOPBACK,
      port: dshPort,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      ...(dshTls ? { servername: 'localhost', rejectUnauthorized: false } : {}),
    }, (up) => {
      const status = up.statusCode ?? 502
      if (status === 401 && req.method === 'GET' && req.url === '/' && String(req.headers.accept ?? '').includes('text/html')) {
        up.resume()
        res.writeHead(302, { location: `${UNLOCK_PATH}?next=${encodeURIComponent('/')}`, 'cache-control': 'no-store' })
        res.end()
        log('GET / -> unlock (no valid cookie)')
        return
      }
      const outHeaders = { ...up.headers }
      delete outHeaders.connection
      delete outHeaders['keep-alive']
      res.writeHead(status, outHeaders)
      up.pipe(res)
    })
    upstream.on('error', (err) => {
      if (res.headersSent) { res.destroy(err); return }
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(errorPage(502, 'The Minimi backend is unavailable.'))
      log('upstream error', err.message)
    })
    req.on('aborted', () => upstream.destroy())
    req.pipe(upstream)
  }

  function exchange(req, res, next) {
    let entry
    try { entry = currentEntryUrl() } catch (err) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(errorPage(503, 'Minimi is still starting. Try again in a moment.'))
      log('exchange unavailable:', err.message)
      return
    }
    const transport = dshTls ? https : http
    const headers = {
      host: publicHost,
      accept: 'text/html',
      'user-agent': String(req.headers['user-agent'] ?? 'Minimi-Gateway'),
      connection: 'close',
    }
    const up = transport.request({
      host: LOOPBACK,
      port: dshPort,
      method: 'GET',
      path: `${entry.pathname}${entry.search}`,
      headers,
      ...(dshTls ? { servername: 'localhost', rejectUnauthorized: false } : {}),
    }, (upRes) => {
      const cookies = upRes.headers['set-cookie'] ?? []
      upRes.resume()
      if ((upRes.statusCode ?? 500) >= 300 && (upRes.statusCode ?? 500) < 400 && cookies.length > 0) {
        res.writeHead(302, {
          'set-cookie': cookies,
          location: safeNext(next),
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        log('unlocked public browser session')
      } else {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(errorPage(502, 'Minimi could not start a session. Try again.'))
        log('token exchange failed', upRes.statusCode)
      }
    })
    up.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(errorPage(502, 'Minimi could not reach its backend.'))
      log('exchange error', err.message)
    })
    up.end()
  }

  function serveUnlock(req, res, query) {
    const next = safeNext(query.get('next') ?? '/')
    if (req.method === 'GET') {
      if (!accessKey) { exchange(req, res, next); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(unlockPage({ next }))
      return
    }
    if (req.method === 'POST') {
      readBody(req).then((body) => {
        const form = new URLSearchParams(body)
        const supplied = form.get('key') ?? ''
        const target = safeNext(form.get('next') ?? next)
        if (!keyMatches(supplied)) {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(unlockPage({ error: 'That key is not valid.', next: target }))
          log('unlock rejected')
          return
        }
        exchange(req, res, target)
      }).catch(() => {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Bad request')
      })
      return
    }
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
  }

  function handler(req, res) {
    const url = new URL(req.url, publicUrl)
    if (url.pathname === HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, keyRequired: Boolean(accessKey) }))
      return
    }
    if (url.pathname === UNLOCK_PATH) { serveUnlock(req, res, url.searchParams); return }
    if (!hasDshCookie(req.headers)) {
      const next = safeNext(req.url)
      res.writeHead(302, { location: `${UNLOCK_PATH}?next=${encodeURIComponent(next)}`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    upstreamRequest(req, res)
  }

  const server = options.tls
    ? https.createServer({ cert: fs.readFileSync(options.tls.cert), key: fs.readFileSync(options.tls.key) }, handler)
    : http.createServer(handler)

  server.on('upgrade', (req, socket, head) => {
    if (!hasDshCookie(req.headers)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const onConnect = (upstream) => {
      const headers = { ...req.headers, host: publicHost }
      headers.connection = 'Upgrade'
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    }
    if (dshTls) {
      const upstream = tls.connect({ host: LOOPBACK, port: dshPort, servername: 'localhost', rejectUnauthorized: false }, () => onConnect(upstream))
      upstream.on('error', () => socket.destroy())
    } else {
      import('node:net').then(({ connect }) => {
        const upstream = connect({ host: LOOPBACK, port: dshPort }, () => onConnect(upstream))
        upstream.on('error', () => socket.destroy())
      }).catch(() => socket.destroy())
    }
  })

  return {
    server,
    async listen(port = 0, host = LOOPBACK) {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => { server.off('error', reject); resolve() })
      })
      return server.address()
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function startFromEnv() {
  const publicUrl = process.env.MINIMI_PUBLIC_URL
  if (!publicUrl) throw new Error('MINIMI_PUBLIC_URL is required')
  const port = Number(process.env.MINIMI_GATEWAY_PORT ?? 8788)
  const cert = process.env.MINIMI_TLS_CERT
  const key = process.env.MINIMI_TLS_KEY
  const accessKeyFile = process.env.MINIMI_ACCESS_KEY_FILE
  const accessKey = process.env.MINIMI_ACCESS_KEY || (accessKeyFile ? readText(accessKeyFile) : '')
  const gateway = createGateway({
    publicUrl,
    dshPort: Number(process.env.MINIMI_DSH_PORT ?? 8789),
    dshTls: process.env.MINIMI_DSH_TLS !== '0',
    entryFile: process.env.MINIMI_DSH_ENTRY_FILE,
    entryUrl: process.env.MINIMI_DSH_ENTRY_URL,
    accessKey,
    tls: cert && key ? { cert, key } : null,
  })
  gateway.listen(port, process.env.MINIMI_GATEWAY_HOST ?? LOOPBACK).then((address) => {
    const scheme = cert && key ? 'https' : 'http'
    console.log(`[gateway] listening on ${scheme}://${LOOPBACK}:${address.port} for ${publicUrl}`)
    console.log(`[gateway] access key ${accessKey ? 'required' : 'not required (public URL access)'}`)
  }).catch((err) => {
    console.error('[gateway] startup failed:', err.message)
    process.exit(1)
  })
  const stop = () => gateway.close().finally(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) startFromEnv()
