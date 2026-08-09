import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  parseStagingWidgetArgs,
  readReviewedWidgetSource,
  readReviewedWidgetStyles,
  validateStagingWidgetInputs,
  verifyStagingWidget,
} from './lib/staging-widget-admission.mjs'

const SHA = 'a'.repeat(40)
const HOST = 'pathfinder-staging.example.test'
const HEALTH_URL = `https://${HOST}/api/health`
const VENUE_SLUG = 'museum-slug'
const UNLISTED_SLUG = 'widget-admission-unlisted'
const FRAME_ORIGINS = ['https://museum.example', 'https://www.museum.example']
const WIDGET_SOURCE = '(function () { "use strict" })()\n'
const WIDGET_STYLES = ':host { position: fixed; }\n'

function response(body, { status = 200, contentType = 'application/json', headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType, ...headers },
  })
}

function healthResponse(overrides = {}) {
  return response(
    {
      ok: true,
      deployment: { environment: 'staging', revision: SHA },
      deps: { db: 'up', queue: 'up' },
      ...overrides,
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}

function embedResponse({ csp, status = 200, headers = {} } = {}) {
  return response('<!doctype html><title>PathFinder</title>', {
    status,
    contentType: 'text/html; charset=utf-8',
    headers: {
      'cache-control': 'private, no-store',
      'content-security-policy': csp ?? `frame-ancestors 'self' ${FRAME_ORIGINS.join(' ')}`,
      'referrer-policy': 'no-referrer',
      'x-pathfinder-revision': SHA,
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
      ...headers,
    },
  })
}

function widgetResponse(body = WIDGET_SOURCE, overrides = {}) {
  return response(body, {
    contentType: 'application/javascript; charset=utf-8',
    headers: {
      'cache-control': 'public, max-age=0, must-revalidate',
      'cross-origin-resource-policy': 'cross-origin',
      'x-content-type-options': 'nosniff',
    },
    ...overrides,
  })
}

function widgetStyleResponse(body = WIDGET_STYLES, overrides = {}) {
  return response(body, {
    contentType: 'text/css; charset=utf-8',
    headers: {
      'cache-control': 'public, max-age=0, must-revalidate',
      'cross-origin-resource-policy': 'cross-origin',
      'x-content-type-options': 'nosniff',
    },
    ...overrides,
  })
}

function widgetReadyResponse({ status = 204, ready = true, headers = {} } = {}) {
  return new Response(null, {
    status,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'X-PathFinder-Revision, X-PathFinder-Widget-Ready',
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'cross-origin',
      'x-content-type-options': 'nosniff',
      'x-pathfinder-revision': SHA,
      ...(ready ? { 'x-pathfinder-widget-ready': '1' } : {}),
      ...headers,
    },
  })
}

function successfulResponses() {
  return [
    healthResponse(),
    widgetResponse(),
    widgetStyleResponse(),
    widgetReadyResponse(),
    widgetReadyResponse({ status: 404, ready: false }),
    embedResponse(),
    embedResponse({ csp: "frame-ancestors 'self'" }),
    embedResponse({ csp: "frame-ancestors 'self'", status: 404 }),
    healthResponse(),
  ]
}

function verification(overrides = {}) {
  const responses = successfulResponses()
  return {
    healthUrl: HEALTH_URL,
    expectedRevision: SHA,
    confirmEnvironment: 'staging',
    confirmHost: HOST,
    venueSlug: VENUE_SLUG,
    expectedFrameOriginsJson: JSON.stringify(FRAME_ORIGINS.slice().reverse()),
    unlistedVenueSlug: UNLISTED_SLUG,
    reviewedWidgetSource: WIDGET_SOURCE,
    reviewedWidgetStyles: WIDGET_STYLES,
    fetchImpl: async () => responses.shift(),
    ...overrides,
  }
}

test('admits an exact-revision widget artifact and exact framing policy through control probes', async () => {
  const requests = []
  const responses = successfulResponses()
  const result = await verifyStagingWidget(
    verification({
      fetchImpl: async (...args) => {
        requests.push(args)
        return responses.shift()
      },
    }),
  )

  assert.deepEqual(result, {
    ok: true,
    host: HOST,
    revision: SHA,
    venueSlug: VENUE_SLUG,
    frameOrigins: FRAME_ORIGINS,
    unlistedVenueSlug: UNLISTED_SLUG,
    unlistedReady: false,
    widgetSha256: '2724d40e1b4d9c8cc98d7ffad9d9ee9120ee227a87bc9435a0220cd0be6d3339',
    widgetStyleSha256: createHash('sha256').update(WIDGET_STYLES).digest('hex'),
    querySelfOnly: true,
    unlistedSelfOnly: true,
  })
  assert.deepEqual(
    requests.map(([url]) => url),
    [
      HEALTH_URL,
      `https://${HOST}/widget.js`,
      `https://${HOST}/widget.css`,
      `https://${HOST}/api/widget-ready/${VENUE_SLUG}`,
      `https://${HOST}/api/widget-ready/${UNLISTED_SLUG}`,
      `https://${HOST}/embed/${VENUE_SLUG}`,
      `https://${HOST}/embed/${VENUE_SLUG}?chrome=hidden`,
      `https://${HOST}/embed/${UNLISTED_SLUG}`,
      HEALTH_URL,
    ],
  )
  for (const [, options] of requests) {
    assert.equal(options.method, 'GET')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
  }
})

test('stops before widget requests when the first health admission fails', async () => {
  let requests = 0
  await assert.rejects(
    verifyStagingWidget(
      verification({
        fetchImpl: async () => {
          requests += 1
          return healthResponse({
            deployment: { environment: 'staging', revision: 'b'.repeat(40) },
          })
        },
      }),
    ),
    /health-before-revision-mismatch/u,
  )
  assert.equal(requests, 1)
})

test('fails when the deployment changes during the health sandwich', async () => {
  const responses = successfulResponses()
  responses[8] = healthResponse({
    deployment: { environment: 'staging', revision: 'b'.repeat(40) },
  })
  await assert.rejects(
    verifyStagingWidget(verification({ fetchImpl: async () => responses.shift() })),
    /health-after-revision-mismatch/u,
  )
})

test('requires the remote loader bytes and delivery headers to match the reviewed artifact', async () => {
  for (const candidate of [
    widgetResponse('different'),
    widgetResponse(WIDGET_SOURCE, { contentType: 'text/plain' }),
    widgetResponse(WIDGET_SOURCE, {
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    }),
    widgetResponse(WIDGET_SOURCE, {
      headers: { 'cache-control': 'public, max-age=0, must-revalidate' },
    }),
    widgetResponse(WIDGET_SOURCE, {
      headers: {
        'cache-control': 'public, max-age=0, must-revalidate',
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
      },
    }),
  ]) {
    const responses = successfulResponses()
    responses[1] = candidate
    await assert.rejects(
      verifyStagingWidget(verification({ fetchImpl: async () => responses.shift() })),
    )
  }
})

test('cancels an oversized loader response before reading it all', async () => {
  let cancelled = false
  let emitted = 0
  const oversized = new Response(
    new ReadableStream({
      pull(controller) {
        emitted += 1
        controller.enqueue(new Uint8Array(4_096))
      },
      cancel() {
        cancelled = true
      },
    }),
    {
      headers: {
        'content-type': 'application/javascript',
        'cache-control': 'public, max-age=0, must-revalidate',
        'cross-origin-resource-policy': 'cross-origin',
        'x-content-type-options': 'nosniff',
      },
    },
  )
  const responses = successfulResponses()
  responses[1] = oversized
  await assert.rejects(
    verifyStagingWidget(verification({ fetchImpl: async () => responses.shift() })),
    /widget-body-size/u,
  )
  assert.equal(cancelled, true)
  assert.ok(emitted < 10)
})

test('requires the exact remote stylesheet bytes and cross-origin delivery policy', async () => {
  for (const candidate of [
    widgetStyleResponse('different'),
    widgetStyleResponse(WIDGET_STYLES, { contentType: 'text/plain' }),
    widgetStyleResponse(WIDGET_STYLES, {
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    }),
    widgetStyleResponse(WIDGET_STYLES, {
      headers: {
        'cache-control': 'public, max-age=0, must-revalidate',
        'cross-origin-resource-policy': 'same-origin',
      },
    }),
  ]) {
    const responses = successfulResponses()
    responses[2] = candidate
    await assert.rejects(
      verifyStagingWidget(verification({ fetchImpl: async () => responses.shift() })),
    )
  }
})

test('cancels an invalid asset response instead of leaving its body open', async () => {
  let cancelled = false
  const invalidStyle = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true
      },
    }),
    {
      headers: {
        'content-type': 'text/plain',
        'cache-control': 'public, max-age=0, must-revalidate',
        'cross-origin-resource-policy': 'cross-origin',
        'x-content-type-options': 'nosniff',
      },
    },
  )
  const responses = successfulResponses()
  responses[2] = invalidStyle

  await assert.rejects(
    verifyStagingWidget(verification({ fetchImpl: async () => responses.shift() })),
    /widget-style-content-type/u,
  )
  assert.equal(cancelled, true)
})

test('requires an exact-revision bodyless cross-origin readiness signal', async () => {
  for (const candidate of [
    widgetReadyResponse({ status: 503 }),
    widgetReadyResponse({ headers: { 'access-control-allow-origin': 'https://venue.example' } }),
    widgetReadyResponse({ headers: { 'cache-control': 'public, max-age=60' } }),
    widgetReadyResponse({ headers: { 'x-pathfinder-widget-ready': '0' } }),
    widgetReadyResponse({ headers: { 'x-pathfinder-revision': 'b'.repeat(40) } }),
  ]) {
    const responses = successfulResponses()
    responses[3] = candidate
    await assert.rejects(
      verifyStagingWidget(verification({ fetchImpl: async () => responses.shift() })),
    )
  }
})

test('requires the confirmed unlisted venue readiness probe to fail closed', async () => {
  for (const candidate of [
    widgetReadyResponse(),
    widgetReadyResponse({ status: 404, ready: true }),
    widgetReadyResponse({
      status: 404,
      ready: false,
      headers: { 'x-pathfinder-revision': 'b'.repeat(40) },
    }),
  ]) {
    const responses = successfulResponses()
    responses[4] = candidate
    await assert.rejects(
      verifyStagingWidget(verification({ fetchImpl: async () => responses.shift() })),
    )
  }
})

test('requires an exact framing-origin list rather than a permissive subset', async () => {
  for (const csp of [
    "frame-ancestors 'self' https://museum.example",
    `frame-ancestors 'self' ${FRAME_ORIGINS.join(' ')} https://extra.example`,
    "frame-ancestors 'self' https://www.museum.example https://museum.example",
    "frame-ancestors 'self' *",
  ]) {
    const responses = successfulResponses()
    responses[5] = embedResponse({ csp })
    await assert.rejects(
      verifyStagingWidget(verification({ fetchImpl: async () => responses.shift() })),
    )
  }
})

test('rejects unsafe or weakened admitted embed responses', async () => {
  const candidates = [
    embedResponse({ headers: { 'cache-control': 'public, max-age=60' } }),
    embedResponse({ headers: { 'referrer-policy': 'origin' } }),
    embedResponse({ headers: { 'x-content-type-options': 'none' } }),
    embedResponse({ headers: { 'x-robots-tag': 'index, follow' } }),
    embedResponse({ headers: { 'access-control-allow-origin': '*' } }),
    embedResponse({ headers: { 'x-pathfinder-revision': 'b'.repeat(40) } }),
  ]
  for (const candidate of candidates) {
    const responses = successfulResponses()
    responses[5] = candidate
    await assert.rejects(
      verifyStagingWidget(verification({ fetchImpl: async () => responses.shift() })),
    )
  }
})

test('does not let a stalled response-body cancellation defeat the request deadline', async () => {
  function nonCancellingEmbed({ csp, status = 200 }) {
    return new Response(
      new ReadableStream({
        cancel() {
          return new Promise(() => undefined)
        },
      }),
      {
        status,
        headers: {
          'content-type': 'text/html',
          'cache-control': 'private, no-store',
          'content-security-policy': csp,
          'referrer-policy': 'no-referrer',
          'x-pathfinder-revision': SHA,
          'x-content-type-options': 'nosniff',
          'x-robots-tag': 'noindex, nofollow',
        },
      },
    )
  }

  const responses = successfulResponses()
  responses[5] = nonCancellingEmbed({ csp: `frame-ancestors 'self' ${FRAME_ORIGINS.join(' ')}` })
  responses[6] = nonCancellingEmbed({ csp: "frame-ancestors 'self'" })
  responses[7] = nonCancellingEmbed({ csp: "frame-ancestors 'self'", status: 404 })

  await Promise.race([
    verifyStagingWidget(verification({ timeoutMs: 100, fetchImpl: async () => responses.shift() })),
    new Promise((_, reject) => setTimeout(() => reject(new Error('verifier-stalled')), 500)),
  ])
})

test('requires query and explicitly confirmed unlisted controls to remain self-only', async () => {
  const queryResponses = successfulResponses()
  queryResponses[6] = embedResponse()
  await assert.rejects(
    verifyStagingWidget(verification({ fetchImpl: async () => queryResponses.shift() })),
    /query-control-not-self-only/u,
  )

  const unlistedResponses = successfulResponses()
  unlistedResponses[7] = embedResponse({
    csp: `frame-ancestors 'self' ${FRAME_ORIGINS[0]}`,
    status: 404,
  })
  await assert.rejects(
    verifyStagingWidget(verification({ fetchImpl: async () => unlistedResponses.shift() })),
    /unlisted-control-not-self-only/u,
  )
})

test('validates exact arguments, slugs, origins, and explicit confirmations', () => {
  const required = [
    '--url',
    HEALTH_URL,
    '--expected-revision',
    SHA,
    '--confirm-environment',
    'staging',
    '--confirm-host',
    HOST,
    '--venue-slug',
    VENUE_SLUG,
    '--expected-frame-origins-json',
    JSON.stringify(FRAME_ORIGINS),
    '--unlisted-venue-slug',
    UNLISTED_SLUG,
  ]
  assert.equal(parseStagingWidgetArgs(required).timeoutMs, 5_000)
  assert.throws(() => parseStagingWidgetArgs([...required, '--other', 'x']), /unknown-option/u)
  assert.throws(
    () => parseStagingWidgetArgs([...required, '--url', HEALTH_URL]),
    /duplicate-option/u,
  )
  assert.throws(() => parseStagingWidgetArgs(required.slice(0, -2)), /missing-required-option/u)

  const base = parseStagingWidgetArgs(required)
  assert.throws(
    () => validateStagingWidgetInputs({ ...base, venueSlug: '../venue' }),
    /invalid-venue/u,
  )
  assert.throws(
    () => validateStagingWidgetInputs({ ...base, unlistedVenueSlug: 'Venue' }),
    /invalid-venue/u,
  )
  assert.throws(
    () => validateStagingWidgetInputs({ ...base, unlistedVenueSlug: VENUE_SLUG }),
    /control-venue-slug-not-distinct/u,
  )
  for (const origins of [
    '[]',
    '{}',
    '["http://museum.example"]',
    '["https://museum.example/path"]',
    '["https://*.museum.example"]',
    '["https://museum.example","https://museum.example"]',
  ]) {
    assert.throws(() => validateStagingWidgetInputs({ ...base, expectedFrameOriginsJson: origins }))
  }
})

test('reads the reviewed loader from the exact Git revision with argument-safe calls', async () => {
  const calls = []
  const source = await readReviewedWidgetSource(SHA, {
    root: 'C:\\reviewed-pathfinder',
    spawn(command, args, options) {
      calls.push({ command, args, options })
      return args[0] === 'cat-file'
        ? { status: 0, stdout: '' }
        : { status: 0, stdout: new TextEncoder().encode(WIDGET_SOURCE) }
    },
  })
  assert.equal(new TextDecoder().decode(source), WIDGET_SOURCE)
  assert.deepEqual(
    calls.map(({ command, args }) => [command, args]),
    [
      ['git', ['cat-file', '-e', `${SHA}:apps/web/public/widget.js`]],
      ['git', ['show', `${SHA}:apps/web/public/widget.js`]],
    ],
  )

  await assert.rejects(
    readReviewedWidgetSource(SHA, { spawn: () => ({ status: 1, stdout: '' }) }),
    /reviewed-widget-source-missing/u,
  )
})

test('reads the reviewed stylesheet from the exact Git revision with argument-safe calls', async () => {
  const calls = []
  const source = await readReviewedWidgetStyles(SHA, {
    root: 'C:\\reviewed-pathfinder',
    spawn(command, args, options) {
      calls.push({ command, args, options })
      return args[0] === 'cat-file'
        ? { status: 0, stdout: '' }
        : { status: 0, stdout: new TextEncoder().encode(WIDGET_STYLES) }
    },
  })
  assert.equal(new TextDecoder().decode(source), WIDGET_STYLES)
  assert.deepEqual(
    calls.map(({ command, args }) => [command, args]),
    [
      ['git', ['cat-file', '-e', `${SHA}:apps/web/public/widget.css`]],
      ['git', ['show', `${SHA}:apps/web/public/widget.css`]],
    ],
  )

  await assert.rejects(
    readReviewedWidgetStyles(SHA, { spawn: () => ({ status: 1, stdout: '' }) }),
    /reviewed-widget-styles-missing/u,
  )
})

test('wires the operator command, CI contract, and documented limitations', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(
    packageJson.scripts['verify:staging-widget'],
    'node scripts/verify-staging-widget.mjs',
  )
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(ci, /node --test scripts\/staging-widget-admission\.test\.mjs/u)
  const widgetGuide = readFileSync(new URL('../docs/widget-preview.md', import.meta.url), 'utf8')
  assert.match(widgetGuide, /pnpm verify:staging-widget/u)
  assert.match(widgetGuide, /does not replace third-party browser proof/u)
  const stagingGuide = readFileSync(new URL('../docs/railway-staging.md', import.meta.url), 'utf8')
  assert.match(stagingGuide, /exact-revision widget admission/u)
})

test('CLI rejects unsafe input with a code only and never echoes URL credentials', () => {
  const cli = fileURLToPath(new URL('./verify-staging-widget.mjs', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [
      cli,
      '--url',
      `https://operator:private-marker@${HOST}/api/health`,
      '--expected-revision',
      SHA,
      '--confirm-environment',
      'staging',
      '--confirm-host',
      HOST,
      '--venue-slug',
      VENUE_SLUG,
      '--expected-frame-origins-json',
      JSON.stringify(FRAME_ORIGINS),
      '--unlisted-venue-slug',
      UNLISTED_SLUG,
    ],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Staging widget admission failed: unsafe-health-url\n')
  assert.doesNotMatch(result.stderr, /private-marker/u)
})
