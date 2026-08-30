import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  parseStagingHealthArgs,
  validateStagingHealthPayload,
  validateStagingHealthUrl,
  verifyStagingHealth,
} from './lib/staging-health-admission.mjs'

const SHA = 'a'.repeat(40)
const HOST = 'pathfinder-staging.example.test'
const URL = `https://${HOST}/api/health`
const RESOURCES = {
  database: 'db-staging-example',
  redis: 'redis-staging-example',
  storage: 'storage-disabled',
}

function response(
  payload,
  { status = 200, contentType = 'application/json', cacheControl = 'no-store' } = {},
) {
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
    status,
    headers: { 'content-type': contentType, 'cache-control': cacheControl },
  })
}

function healthyPayload(overrides = {}) {
  return {
    ok: true,
    deployment: { environment: 'staging', revision: SHA, resources: RESOURCES },
    deps: { db: 'up', queue: 'up' },
    ...overrides,
  }
}

function verification(overrides = {}) {
  return {
    healthUrl: URL,
    expectedRevision: SHA,
    confirmEnvironment: 'staging',
    confirmHost: HOST,
    expectedResources: RESOURCES,
    fetchImpl: async () => response(healthyPayload()),
    ...overrides,
  }
}

test('admits only an exact healthy staging revision and uses a bounded non-cached GET', async () => {
  let request
  const result = await verifyStagingHealth(
    verification({
      fetchImpl: async (...args) => {
        request = args
        return response(healthyPayload())
      },
    }),
  )

  assert.deepEqual(result, {
    host: HOST,
    ok: true,
    environment: 'staging',
    revision: SHA,
    resources: RESOURCES,
    deps: { db: 'up', queue: 'up' },
  })
  assert.equal(request[0], URL)
  assert.equal(request[1].method, 'GET')
  assert.equal(request[1].cache, 'no-store')
  assert.equal(request[1].redirect, 'error')
  assert.equal(request[1].headers.accept, 'application/json')
  assert.ok(request[1].signal instanceof AbortSignal)
})

test('rejects wrong environment, wrong revision, and degraded dependencies', () => {
  assert.throws(
    () =>
      validateStagingHealthPayload(
        healthyPayload({
          deployment: { environment: 'production', revision: SHA, resources: RESOURCES },
        }),
        SHA,
        RESOURCES,
      ),
    /environment-mismatch/u,
  )
  assert.throws(
    () => validateStagingHealthPayload(healthyPayload(), 'b'.repeat(40), RESOURCES),
    /revision-mismatch/u,
  )
  assert.throws(
    () =>
      validateStagingHealthPayload(
        healthyPayload({ deps: { db: 'up', queue: 'down' } }),
        SHA,
        RESOURCES,
      ),
    /dependency-not-ready/u,
  )
})

test('requires an exact response schema', () => {
  assert.throws(
    () => validateStagingHealthPayload({ ...healthyPayload(), extra: true }, SHA, RESOURCES),
    /invalid-health-payload/u,
  )
  assert.throws(
    () =>
      validateStagingHealthPayload(
        { ok: true, deployment: healthyPayload().deployment },
        SHA,
        RESOURCES,
      ),
    /invalid-health-payload/u,
  )
  assert.throws(
    () =>
      validateStagingHealthPayload(
        healthyPayload({ deployment: { ...healthyPayload().deployment, tag: 'latest' } }),
        SHA,
        RESOURCES,
      ),
    /invalid-deployment-identity/u,
  )
  assert.throws(
    () =>
      validateStagingHealthPayload(
        healthyPayload({ deps: { ...healthyPayload().deps, storage: 'up' } }),
        SHA,
        RESOURCES,
      ),
    /invalid-dependency-status/u,
  )
  assert.throws(
    () =>
      validateStagingHealthPayload(healthyPayload(), SHA, {
        ...RESOURCES,
        database: 'other-database',
      }),
    /resource-identity-mismatch/u,
  )
})

test('requires a full immutable SHA and explicit environment and host confirmation', async () => {
  await assert.rejects(
    verifyStagingHealth(verification({ expectedRevision: 'main' })),
    /invalid-expected-revision/u,
  )
  await assert.rejects(
    verifyStagingHealth(verification({ confirmEnvironment: '' })),
    /missing-staging-confirmation/u,
  )
  await assert.rejects(
    verifyStagingHealth(verification({ confirmHost: 'other.example.test' })),
    /host-confirmation-mismatch/u,
  )
})

test('accepts only an uncredentialed HTTPS health endpoint with no query or fragment', () => {
  assert.equal(validateStagingHealthUrl(URL), URL)
  for (const value of [
    'http://pathfinder-staging.example.test/api/health',
    'https://user:pass@pathfinder-staging.example.test/api/health',
    'https://pathfinder-staging.example.test/other',
    'https://pathfinder-staging.example.test/api/health?token=value',
    'https://pathfinder-staging.example.test/api/health?',
    'https://pathfinder-staging.example.test/api/health#fragment',
    'https://pathfinder-staging.example.test/api/health#',
    'https://localhost/api/health',
    'https://localhost./api/health',
    'https://127.0.0.1/api/health',
    'https://10.0.0.1/api/health',
    'https://169.254.1.1/api/health',
    'https://[::1]/api/health',
  ]) {
    assert.throws(() => validateStagingHealthUrl(value), /(invalid|unsafe)-health-url/u)
  }
})

test('cancels a chunked response as soon as it exceeds the byte ceiling', async () => {
  let cancelled = false
  let emitted = 0
  const body = new ReadableStream({
    pull(controller) {
      emitted += 1
      controller.enqueue(new Uint8Array(2_048))
    },
    cancel() {
      cancelled = true
    },
  })
  const oversized = new Response(body, {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

  await assert.rejects(
    verifyStagingHealth(verification({ fetchImpl: async () => oversized })),
    /health-body-size/u,
  )
  assert.equal(cancelled, true)
  assert.ok(emitted < 10)
})

test('rejects non-JSON, malformed, oversized, non-200, and cacheable responses', async () => {
  const cases = [
    response(healthyPayload(), { status: 503 }),
    response(healthyPayload(), { contentType: 'text/html' }),
    response(healthyPayload(), { contentType: 'application/jsonp' }),
    response('{invalid'),
    response('x'.repeat(4_097)),
    response(healthyPayload(), { cacheControl: 'public, max-age=60' }),
  ]

  for (const candidate of cases) {
    await assert.rejects(verifyStagingHealth(verification({ fetchImpl: async () => candidate })))
  }
})

test('contains transport failures and rejects unsafe timeout values', async () => {
  await assert.rejects(
    verifyStagingHealth(
      verification({
        fetchImpl: async () => {
          throw new Error('private transport detail')
        },
      }),
    ),
    (error) => error.message === 'health-request-failed',
  )
  await assert.rejects(verifyStagingHealth(verification({ timeoutMs: 60_000 })), /invalid-timeout/u)
})

test('bounds a stalled response body with the same request deadline', async () => {
  let cancelled = false
  const stalled = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true
      },
    }),
    { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  )

  await assert.rejects(
    verifyStagingHealth(verification({ timeoutMs: 100, fetchImpl: async () => stalled })),
    /health-request-failed/u,
  )
  assert.equal(cancelled, true)
})

test('CLI parser rejects unknown, duplicate, missing, and incomplete options', () => {
  const required = [
    '--url',
    URL,
    '--expected-revision',
    SHA,
    '--confirm-environment',
    'staging',
    '--confirm-host',
    HOST,
    '--expected-database-resource',
    RESOURCES.database,
    '--expected-redis-resource',
    RESOURCES.redis,
    '--expected-storage-resource',
    RESOURCES.storage,
  ]
  assert.deepEqual(parseStagingHealthArgs(required), {
    healthUrl: URL,
    expectedRevision: SHA,
    confirmEnvironment: 'staging',
    confirmHost: HOST,
    expectedResources: RESOURCES,
    timeoutMs: 5_000,
  })
  assert.throws(() => parseStagingHealthArgs([...required, '--other', 'x']), /unknown-option/u)
  assert.throws(() => parseStagingHealthArgs([...required, '--url', URL]), /duplicate-option/u)
  assert.throws(
    () => parseStagingHealthArgs([...required, '--timeout-ms']),
    /missing-option-value/u,
  )
  assert.throws(() => parseStagingHealthArgs(required.slice(0, -2)), /missing-required-option/u)
})

test('CLI wiring fails with a code-only error and never echoes URL credentials', () => {
  const packageJson = JSON.parse(
    readFileSync(new globalThis.URL('../package.json', import.meta.url), 'utf8'),
  )
  assert.equal(
    packageJson.scripts['verify:staging-health'],
    'node scripts/verify-staging-health.mjs',
  )

  const cli = fileURLToPath(new globalThis.URL('./verify-staging-health.mjs', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [
      cli,
      '--url',
      'https://operator:private-marker@pathfinder-staging.example.test/api/health',
      '--expected-revision',
      SHA,
      '--confirm-environment',
      'staging',
      '--confirm-host',
      HOST,
      '--expected-database-resource',
      RESOURCES.database,
      '--expected-redis-resource',
      RESOURCES.redis,
      '--expected-storage-resource',
      RESOURCES.storage,
    ],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Staging health admission failed: unsafe-health-url\n')
  assert.doesNotMatch(result.stderr, /private-marker/u)
})

test('release policy targets the product health origin rather than the separate marketing site', () => {
  const policy = JSON.parse(
    readFileSync(new globalThis.URL('./release-verification-policy.json', import.meta.url), 'utf8'),
  )
  const health = new globalThis.URL(policy.staging.healthUrl)
  assert.equal(health.protocol, 'https:')
  assert.equal(health.pathname, '/api/health')
  assert.equal(health.hostname, policy.staging.host)
  assert.notEqual(health.hostname, 'staging.torchiko.com')
})
