import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const port = Number(process.env.TORCHIKO_DISTRIBUTION_WEB_PORT ?? 4173)
const admittedOrigin = process.env.TORCHIKO_DISTRIBUTION_ADMITTED_ORIGIN ?? 'http://127.0.0.1:4174'
let state = 'active'

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })
  response.end(body)
}

function routeShell(slug, path, isAdmitted) {
  const title = path.endsWith('/inline') ? 'Inline venue guide' : 'Torchiko venue guide'
  const csp = isAdmitted ? `frame-ancestors 'self' ${admittedOrigin}` : "frame-ancestors 'self'"
  const stateMessage = state === 'paused' ? 'Venue temporarily unavailable' : 'CITY SC visitor guide'
  const fixtureScript = `
    (function () {
      const key = 'torchiko-distribution-session-${slug}'
      let count = Number(sessionStorage.getItem(key) || 0)
      const question = document.querySelector('#question')
      document.querySelector('#count').textContent = String(count)
      document.querySelector('#send').addEventListener('click', function () {
        count += 1
        sessionStorage.setItem(key, String(count))
        document.querySelector('#count').textContent = String(count)
        document.querySelector('#answer').textContent = 'Question saved in this browser session.'
      })
      const initialAsk = new URLSearchParams(location.search).get('ask')
      if (initialAsk && initialAsk.length <= 200) question.value = initialAsk
      window.addEventListener('message', function (event) {
        if (event.source !== parent || event.origin !== '${admittedOrigin}') return
        const data = event.data
        if (!data || data.source !== 'torchiko' || data.v !== 1) return
        if (data.type === 'prefill' && typeof data.payload?.ask === 'string' && data.payload.ask.length <= 200) {
          question.value = data.payload.ask
        }
        if (data.type === 'open') parent.postMessage({ source: 'torchiko', v: 1, type: 'open', payload: null }, '${admittedOrigin}')
      })
      parent.postMessage({ type: 'pathfinder:embed-ready', version: 1, venueSlug: '${slug}' }, '${admittedOrigin}')
      parent.postMessage({ source: 'torchiko', v: 1, type: 'ready', payload: null }, '${admittedOrigin}')
      if (location.pathname.endsWith('/inline')) {
        parent.postMessage({ source: 'torchiko', v: 1, type: 'height', payload: { height: 720 } }, '${admittedOrigin}')
      }
    })()
  `
  return {
    status: 200,
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui;margin:24px;color:#142b39}input,button{font:inherit;padding:10px}#answer{margin-top:12px}</style></head><body><main><h1>${stateMessage}</h1><p id="session">Session: <span id="count">0</span></p><label>Question <input id="question" aria-label="Question"></label><button id="send" type="button">Send</button><p id="answer" aria-live="polite"></p></main><script>${fixtureScript}</script></body></html>`,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp },
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
  const pathname = url.pathname
  if (pathname === '/__test_state' && request.method === 'POST') {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!['active', 'revoked', 'disabled', 'paused'].includes(payload.state)) throw new Error('invalid state')
      state = payload.state
      send(response, 200, JSON.stringify({ state }), { 'Content-Type': 'application/json' })
    } catch {
      send(response, 400, JSON.stringify({ error: 'invalid state' }), { 'Content-Type': 'application/json' })
    }
    return
  }
  if (pathname.startsWith('/api/widget-ready/')) {
    const origin = request.headers.origin ?? ''
    const allowed = origin === admittedOrigin && state === 'active'
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}
    if (!allowed) return send(response, 404, '', cors)
    return send(response, 200, JSON.stringify({ v: 2, label: 'Ask CITY', accent: '#0b5cff', theme: 'light', background: '#ffffff' }), {
      ...cors,
      'Content-Type': 'application/json',
    })
  }
  const embedMatch = pathname.match(/^\/embed\/([a-z0-9-]+)(\/inline)?$/)
  if (embedMatch) {
    const isAdmitted = state === 'active'
    const page = routeShell(embedMatch[1], pathname, isAdmitted)
    return send(response, page.status, page.body, page.headers)
  }
  if (pathname === '/widget.js' || pathname === '/widget.css') {
    try {
      const contents = await readFile(fileURLToPath(new URL(`../../apps/web/public/${pathname.slice(1)}`, import.meta.url)))
      return send(response, 200, contents, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      })
    } catch {
      send(response, 500, 'Harness asset unavailable')
      return
    }
  }
  if (pathname === '/health') return send(response, 200, 'ok')
  send(response, 404, 'not found')
})

server.listen(port, '127.0.0.1', () => console.log(`Distribution mock web origin: http://127.0.0.1:${port} (admitted host ${admittedOrigin})`))
