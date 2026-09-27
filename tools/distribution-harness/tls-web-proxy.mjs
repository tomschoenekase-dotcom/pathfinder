import { request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { appendFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'

const certificatePath = process.env.TORCHIKO_DISTRIBUTION_TLS_PFX
const webOrigin = new URL(process.env.TORCHIKO_DISTRIBUTION_WEB_ORIGIN ?? 'https://localhost:4173')
const target = new URL(process.env.TORCHIKO_DISTRIBUTION_WEB_PROXY_TARGET ?? 'http://127.0.0.1:4175')
const requestLog = process.env.TORCHIKO_DISTRIBUTION_REQUEST_LOG
const port = Number(webOrigin.port || 443)

if (webOrigin.protocol !== 'https:' || webOrigin.hostname !== 'localhost' || !certificatePath) {
  throw new Error('Real-stack proxy requires an HTTPS localhost web origin and a task-local TLS PFX path.')
}
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') {
  throw new Error('The local Next.js upstream must be HTTP on exact loopback 127.0.0.1.')
}

const tlsOptions = {
  pfx: readFileSync(certificatePath),
  passphrase: process.env.TORCHIKO_DISTRIBUTION_TLS_PFX_PASSWORD ?? 'distribution-fixture-only',
}
const handler = (incoming, outgoing) => {
  if (requestLog && incoming.url?.startsWith('/api/widget-ready/')) {
    appendFileSync(requestLog, `${JSON.stringify({
      path: new URL(incoming.url, webOrigin).pathname,
      origin: incoming.headers.origin ?? null,
      secFetchSite: incoming.headers['sec-fetch-site'] ?? null,
    })}\n`)
  }
  const headers = { ...incoming.headers }
  delete headers.connection
  delete headers['proxy-connection']
  headers.host = target.host
  headers['x-forwarded-host'] = incoming.headers.host ?? webOrigin.host
  headers['x-forwarded-proto'] = 'https'

  const upstream = httpRequest({
    hostname: target.hostname,
    port: Number(target.port || 80),
    method: incoming.method,
    path: incoming.url,
    headers,
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers)
    response.pipe(outgoing)
  })
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { 'cache-control': 'no-store' })
    outgoing.end('Local Next.js upstream is unavailable.')
  })
  incoming.pipe(upstream)
}

const servers = [createHttpsServer(tlsOptions, handler), createHttpsServer(tlsOptions, handler)]
servers[0].listen(port, '127.0.0.1', () => {
  console.log(`Distribution HTTPS proxy: ${webOrigin.origin} -> ${target.origin}`)
})
servers[1].listen(port, '::1')
