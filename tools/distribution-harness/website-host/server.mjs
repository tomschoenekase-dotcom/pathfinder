import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.env.TORCHIKO_FIXTURE_PORT ?? 4174)
const certificatePath = process.env.TORCHIKO_DISTRIBUTION_TLS_PFX
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' }

const handler = async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname)
  const search = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).searchParams
  const requestedVenue = search.get('venue') ?? 'city-sc'
  const venue = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requestedVenue) ? requestedVenue : 'city-sc'
  const fixturePage = pathname === '/' ? 'all' : pathname.slice(1)
  const file = ['launcher', 'inline', 'unadmitted', 'all'].includes(fixturePage) ? 'index.html' : fixturePage
  const target = normalize(join(root, file))
  if (!target.startsWith(root)) {
    response.writeHead(404).end()
    return
  }
  try {
    let body = await readFile(target)
    if (file === 'index.html') {
      body = Buffer.from(body.toString('utf8')
        .replace('<body>', `<body data-mode="${fixturePage}">`)
        .replaceAll('data-torchiko-inline="city-sc"', `data-torchiko-inline="${venue}"`))
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(body)
  } catch {
    response.writeHead(404).end()
  }
}

const transport = certificatePath
  ? { pfx: readFileSync(certificatePath), passphrase: process.env.TORCHIKO_DISTRIBUTION_TLS_PFX_PASSWORD ?? 'distribution-fixture-only' }
  : null
const makeServer = () => transport ? createHttpsServer(transport, handler) : createHttpServer(handler)
const servers = [makeServer(), makeServer()]
const scheme = certificatePath ? 'https' : 'http'
servers[0].listen(port, '127.0.0.1', () => console.log(`Distribution fixture host: ${scheme} loopback port ${port}`))
servers[1].listen(port, '::1')
