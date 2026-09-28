import { validateReleaseSha, validateStagingHealthPayload } from '../lib/staging-health-admission.mjs'

const MAX_BYTES = 256_000

function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function validateBaseUrl(raw) {
  let url
  try { url = new URL(raw) } catch { fail('invalid-base-url') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.hostname !== 'staging-web-staging-bbeb.up.railway.app') fail('invalid-base-url')
  return url
}

async function fetchBounded(fetchImpl, url) {
  const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  if (response.status !== 200 || response.redirected) fail('public-readback-status')
  if (!response.body) fail('public-readback-size')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) fail('public-readback-size')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  if (size === 0) fail('public-readback-size')
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { response, body: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
}

export async function runPublicReadback({ baseUrl, expectedRevision, venueSlug, resources, fetchImpl = fetch }) {
  const base = validateBaseUrl(baseUrl)
  validateReleaseSha(expectedRevision)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(venueSlug)) fail('invalid-venue-slug')
  const health = await fetchBounded(fetchImpl, new URL('/api/health', base))
  let payload
  try { payload = JSON.parse(health.body) } catch { fail('invalid-health-json') }
  validateStagingHealthPayload(payload, expectedRevision, resources)
  const guide = await fetchBounded(fetchImpl, new URL(`/${venueSlug}/chat`, base))
  if (!(guide.response.headers.get('content-type') ?? '').includes('text/html')) fail('guide-content-type')
  if (!guide.body.includes('<html') || !guide.body.includes('</html>')) fail('guide-document')
  const embed = await fetchBounded(fetchImpl, new URL(`/embed/${venueSlug}`, base))
  const csp = embed.response.headers.get('content-security-policy') ?? ''
  if (!/\bframe-ancestors\s+[^;]+/u.test(csp)) fail('missing-frame-policy')
  if (!(embed.response.headers.get('content-type') ?? '').includes('text/html')) fail('embed-content-type')
  return { ok: true, revision: expectedRevision, venueSlug, health: true, guide: true, framing: true }
}
