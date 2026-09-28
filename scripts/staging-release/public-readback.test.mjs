import assert from 'node:assert/strict'
import test from 'node:test'
import { runPublicReadback } from './public-readback-lib.mjs'

const sha = 'a'.repeat(40)
const resources = { database: 'database-staging', redis: 'redis-staging', storage: 'storage-staging' }
const html = '<html><body>Guide</body></html>'
function response(body, headers = {}) { return new Response(body, { status: 200, headers }) }
function fetchFor({ healthSha = sha, csp = "frame-ancestors 'self' https://partner.example", guideStatus = 200 } = {}) {
  return async (url) => {
    const pathname = new URL(url).pathname
    if (pathname === '/api/health') return response(JSON.stringify({ ok: true, deployment: { environment: 'staging', revision: healthSha, resources }, deps: { db: 'up', queue: 'up' } }))
    if (pathname === '/museum/chat') return new Response(html, { status: guideStatus, headers: { 'content-type': 'text/html' } })
    if (pathname === '/embed/museum') return response(html, { 'content-type': 'text/html', 'content-security-policy': csp })
    throw new Error('unexpected URL')
  }
}
const input = { baseUrl: 'https://staging-web-staging-bbeb.up.railway.app/', expectedRevision: sha, venueSlug: 'museum', resources }

test('read-only public journey validates exact revision and framing', async () => {
  assert.deepEqual(await runPublicReadback({ ...input, fetchImpl: fetchFor() }), { ok: true, revision: sha, venueSlug: 'museum', health: true, guide: true, framing: true })
})
test('wrong revision stops before guide', async () => {
  await assert.rejects(runPublicReadback({ ...input, fetchImpl: fetchFor({ healthSha: 'b'.repeat(40) }) }))
})
test('missing frame policy fails closed', async () => {
  await assert.rejects(runPublicReadback({ ...input, fetchImpl: fetchFor({ csp: '' }) }), { code: 'missing-frame-policy' })
})
test('unavailable guide fails closed', async () => {
  await assert.rejects(runPublicReadback({ ...input, fetchImpl: fetchFor({ guideStatus: 404 }) }), { code: 'public-readback-status' })
})
test('arbitrary host is rejected before request', async () => {
  await assert.rejects(runPublicReadback({ ...input, baseUrl: 'https://production.example/', fetchImpl: fetchFor() }), { code: 'invalid-base-url' })
})

test('oversized public response stops before reading the guide', async () => {
  let requests = 0
  const fetchImpl = async () => {
    requests += 1
    return response('x'.repeat(256_001))
  }
  await assert.rejects(runPublicReadback({ ...input, fetchImpl }), { code: 'public-readback-size' })
  assert.equal(requests, 1)
})
