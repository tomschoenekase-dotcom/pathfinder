import { isIP } from 'node:net'

const FULL_GIT_SHA = /^[0-9a-f]{40}$/u
const MAX_RESPONSE_BYTES = 4_096
const BODY_READ_ABORTED = Symbol('body-read-aborted')

export class StagingHealthAdmissionError extends Error {
  constructor(code) {
    super(code)
    this.name = 'StagingHealthAdmissionError'
    this.code = code
  }
}

function fail(code) {
  throw new StagingHealthAdmissionError(code)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false
  const actualKeys = Object.keys(value).sort()
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys
      .slice()
      .sort()
      .every((key, index) => actualKeys[index] === key)
  )
}

async function readBoundedResponseBody(response, signal) {
  const reader = response.body?.getReader()
  if (!reader) fail('health-body-read-failed')

  const chunks = []
  let totalBytes = 0
  let onAbort
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(BODY_READ_ABORTED)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted])
      if (next === BODY_READ_ABORTED) {
        void reader.cancel().catch(() => undefined)
        fail('health-request-failed')
      }
      const { done, value } = next
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined)
        fail('health-body-size')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof StagingHealthAdmissionError) throw error
    fail('health-body-read-failed')
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }

  if (totalBytes === 0) fail('health-body-size')
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('health-body-read-failed')
  }
}

export function parseStagingHealthArgs(args) {
  const allowed = new Set([
    '--url',
    '--expected-revision',
    '--confirm-environment',
    '--confirm-host',
    '--expected-database-resource',
    '--expected-redis-resource',
    '--expected-storage-resource',
    '--timeout-ms',
  ])
  const values = new Map()

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!allowed.has(option)) fail('unknown-option')
    if (values.has(option)) fail('duplicate-option')
    if (value === undefined || value.startsWith('--')) fail('missing-option-value')
    values.set(option, value)
  }

  for (const required of [
    '--url',
    '--expected-revision',
    '--confirm-environment',
    '--confirm-host',
    '--expected-database-resource',
    '--expected-redis-resource',
    '--expected-storage-resource',
  ]) {
    if (!values.has(required)) fail('missing-required-option')
  }

  return {
    healthUrl: values.get('--url'),
    expectedRevision: values.get('--expected-revision'),
    confirmEnvironment: values.get('--confirm-environment'),
    confirmHost: values.get('--confirm-host'),
    expectedResources: {
      database: values.get('--expected-database-resource'),
      redis: values.get('--expected-redis-resource'),
      storage: values.get('--expected-storage-resource'),
    },
    timeoutMs: values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : 5_000,
  }
}

export function validateStagingHealthUrl(value) {
  if (typeof value !== 'string' || value.includes('?') || value.includes('#')) {
    fail('invalid-health-url')
  }

  let url
  try {
    url = new URL(value)
  } catch {
    fail('invalid-health-url')
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
    .toLowerCase()
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/api/health' ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    isIP(hostname) !== 0
  ) {
    fail('unsafe-health-url')
  }

  return url.toString()
}

export function validateReleaseSha(value) {
  if (!FULL_GIT_SHA.test(value)) {
    fail('invalid-expected-revision')
  }
  return value
}

export function validateStagingHealthPayload(payload, expectedRevision, expectedResources) {
  validateReleaseSha(expectedRevision)

  if (!hasExactKeys(payload, ['ok', 'deployment', 'deps'])) fail('invalid-health-payload')
  if (payload.ok !== true) fail('health-not-ready')
  if (!hasExactKeys(payload.deployment, ['environment', 'resources', 'revision'])) {
    fail('invalid-deployment-identity')
  }
  if (payload.deployment.environment !== 'staging') fail('environment-mismatch')
  if (payload.deployment.revision !== expectedRevision) fail('revision-mismatch')
  if (!hasExactKeys(payload.deployment.resources, ['database', 'redis', 'storage'])) {
    fail('invalid-resource-identity')
  }
  if (!hasExactKeys(expectedResources, ['database', 'redis', 'storage'])) {
    fail('missing-resource-confirmation')
  }
  for (const resource of ['database', 'redis', 'storage']) {
    const expected = expectedResources[resource]
    if (typeof expected !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(expected)) {
      fail('invalid-resource-confirmation')
    }
    if (payload.deployment.resources[resource] !== expected) fail('resource-identity-mismatch')
  }
  if (!hasExactKeys(payload.deps, ['db', 'queue'])) fail('invalid-dependency-status')
  if (payload.deps.db !== 'up' || payload.deps.queue !== 'up') fail('dependency-not-ready')

  return {
    ok: true,
    environment: 'staging',
    revision: expectedRevision,
    resources: expectedResources,
    deps: { db: 'up', queue: 'up' },
  }
}

export async function verifyStagingHealth({
  healthUrl,
  expectedRevision,
  confirmEnvironment,
  confirmHost,
  expectedResources,
  timeoutMs = 5_000,
  fetchImpl = globalThis.fetch,
}) {
  if (confirmEnvironment !== 'staging') fail('missing-staging-confirmation')
  const url = validateStagingHealthUrl(healthUrl)
  const parsedUrl = new URL(url)
  const canonicalHostname = parsedUrl.hostname
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
    .toLowerCase()
  const host = parsedUrl.port === '' ? canonicalHostname : `${canonicalHostname}:${parsedUrl.port}`
  if (confirmHost !== host) fail('host-confirmation-mismatch')
  validateReleaseSha(expectedRevision)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    fail('invalid-timeout')
  }
  if (typeof fetchImpl !== 'function') fail('fetch-unavailable')

  const controller = new AbortController()
  const signal = controller.signal
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal,
      })
    } catch {
      fail('health-request-failed')
    }

    if (response.status !== 200) fail('health-http-status')
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      fail('health-content-type')
    }
    const cacheControl = response.headers.get('cache-control') ?? ''
    if (
      !cacheControl.split(',').some((directive) => directive.trim().toLowerCase() === 'no-store')
    ) {
      fail('health-cache-policy')
    }

    const text = await readBoundedResponseBody(response, signal)

    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      fail('health-json-invalid')
    }

    return {
      host,
      ...validateStagingHealthPayload(payload, expectedRevision, expectedResources),
    }
  } finally {
    clearTimeout(timeout)
  }
}
