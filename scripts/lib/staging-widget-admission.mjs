import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  StagingHealthAdmissionError,
  validateReleaseSha,
  validateStagingHealthUrl,
  verifyStagingHealth,
} from './staging-health-admission.mjs'

const VENUE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const MAX_WIDGET_BYTES = 16_384
const MAX_WIDGET_STYLE_BYTES = 32_768
const MAX_ORIGINS = 20
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 30_000
const BODY_READ_ABORTED = Symbol('body-read-aborted')
const WIDGET_SOURCE_PATH = 'apps/web/public/widget.js'
const WIDGET_STYLE_PATH = 'apps/web/public/widget.css'

export class StagingWidgetAdmissionError extends Error {
  constructor(code) {
    super(code)
    this.name = 'StagingWidgetAdmissionError'
    this.code = code
  }
}

function fail(code) {
  throw new StagingWidgetAdmissionError(code)
}

function failResponse(response, code) {
  void response.body?.cancel().catch(() => undefined)
  fail(code)
}

function hasDirective(value, expected) {
  return value
    .split(',')
    .map((directive) => directive.trim().toLowerCase())
    .includes(expected)
}

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    fail('invalid-timeout')
  }
  return timeoutMs
}

function normalizePublicHttpsOrigin(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value.trim() !== value ||
    /[^\x21-\x7e]/u.test(value) ||
    value.includes('*') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    fail('invalid-expected-origin')
  }

  let url
  try {
    url = new URL(value)
  } catch {
    fail('invalid-expected-origin')
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
    .toLowerCase()
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    isIP(hostname) !== 0 ||
    url.origin !== value
  ) {
    fail('unsafe-expected-origin')
  }

  return url.origin
}

function validateVenueSlug(value) {
  if (typeof value !== 'string' || value.length > 200 || !VENUE_SLUG_PATTERN.test(value)) {
    fail('invalid-venue-slug')
  }
  return value
}

function parseExpectedFrameOrigins(value) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 16_384) {
    fail('invalid-expected-frame-origins')
  }

  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    fail('invalid-expected-frame-origins')
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_ORIGINS) {
    fail('invalid-expected-frame-origins')
  }

  const origins = parsed.map(normalizePublicHttpsOrigin)
  if (new Set(origins).size !== origins.length) fail('duplicate-expected-frame-origin')
  return origins.sort()
}

function validateWidgetSource(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_WIDGET_BYTES
  ) {
    fail('invalid-reviewed-widget-source')
  }
  return bytes
}

function validateWidgetStyles(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_WIDGET_STYLE_BYTES
  ) {
    fail('invalid-reviewed-widget-styles')
  }
  return bytes
}

async function readBoundedBody(response, signal, maximumBytes) {
  const reader = response.body?.getReader()
  if (!reader) fail('widget-body-read-failed')

  const chunks = []
  let totalBytes = 0
  let onAbort
  const aborted = new Promise((resolveAbort) => {
    onAbort = () => resolveAbort(BODY_READ_ABORTED)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted])
      if (next === BODY_READ_ABORTED) {
        void reader.cancel().catch(() => undefined)
        fail('widget-request-failed')
      }
      const { done, value } = next
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maximumBytes) {
        void reader.cancel().catch(() => undefined)
        fail('widget-body-size')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof StagingWidgetAdmissionError) throw error
    fail('widget-body-read-failed')
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }

  if (totalBytes === 0) fail('widget-body-size')
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function fetchSameOrigin(url, { accept, fetchImpl, timeoutMs }) {
  const signal = AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept },
      cache: 'no-store',
      redirect: 'error',
      signal,
    })
  } catch {
    fail('widget-request-failed')
  }
  return { response, signal }
}

function requireEmbedPrivacyHeaders(response, expectedRevision) {
  if (!hasDirective(response.headers.get('cache-control') ?? '', 'private')) {
    failResponse(response, 'embed-cache-policy')
  }
  if (!hasDirective(response.headers.get('cache-control') ?? '', 'no-store')) {
    failResponse(response, 'embed-cache-policy')
  }
  if ((response.headers.get('referrer-policy') ?? '').toLowerCase() !== 'no-referrer') {
    failResponse(response, 'embed-referrer-policy')
  }
  if ((response.headers.get('x-content-type-options') ?? '').toLowerCase() !== 'nosniff') {
    failResponse(response, 'embed-content-type-policy')
  }
  const robots = (response.headers.get('x-robots-tag') ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
  if (!robots.includes('noindex') || !robots.includes('nofollow')) {
    failResponse(response, 'embed-robots-policy')
  }
  if (response.headers.has('access-control-allow-origin')) {
    failResponse(response, 'embed-cors-policy')
  }
  if (response.headers.get('x-pathfinder-revision') !== expectedRevision) {
    failResponse(response, 'embed-revision-mismatch')
  }
}

function requireWidgetReadyHeaders(response, expectedRevision, expectReady) {
  if (response.headers.get('access-control-allow-origin') !== '*') {
    failResponse(response, 'widget-ready-cors-policy')
  }
  const exposedHeaders = (response.headers.get('access-control-expose-headers') ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
  if (
    !exposedHeaders.includes('x-pathfinder-revision') ||
    !exposedHeaders.includes('x-pathfinder-widget-ready')
  ) {
    failResponse(response, 'widget-ready-cors-policy')
  }
  if (!hasDirective(response.headers.get('cache-control') ?? '', 'no-store')) {
    failResponse(response, 'widget-ready-cache-policy')
  }
  if ((response.headers.get('cross-origin-resource-policy') ?? '') !== 'cross-origin') {
    failResponse(response, 'widget-ready-cross-origin-policy')
  }
  if ((response.headers.get('x-content-type-options') ?? '').toLowerCase() !== 'nosniff') {
    failResponse(response, 'widget-ready-content-type-policy')
  }
  const readySignal = response.headers.get('x-pathfinder-widget-ready')
  if ((expectReady && readySignal !== '1') || (!expectReady && readySignal !== null)) {
    failResponse(response, 'widget-ready-signal')
  }
  if (response.headers.get('x-pathfinder-revision') !== expectedRevision) {
    failResponse(response, 'widget-ready-revision-mismatch')
  }
}

function parseFrameAncestors(value) {
  if (typeof value !== 'string' || value.includes(';')) fail('invalid-frame-ancestors')
  const tokens = value.split(/\s+/u)
  if (tokens.length < 2 || tokens[0] !== 'frame-ancestors' || tokens[1] !== "'self'") {
    fail('invalid-frame-ancestors')
  }

  const origins = []
  const seen = new Set()
  for (const token of tokens.slice(2)) {
    const origin = normalizePublicHttpsOrigin(token)
    if (seen.has(origin)) fail('duplicate-frame-origin')
    seen.add(origin)
    origins.push(origin)
  }
  return origins
}

export function parseStagingWidgetArgs(args) {
  const allowed = new Set([
    '--url',
    '--expected-revision',
    '--confirm-environment',
    '--confirm-host',
    '--expected-database-resource',
    '--expected-redis-resource',
    '--expected-storage-resource',
    '--venue-slug',
    '--expected-frame-origins-json',
    '--unlisted-venue-slug',
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
    '--venue-slug',
    '--expected-frame-origins-json',
    '--unlisted-venue-slug',
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
    venueSlug: values.get('--venue-slug'),
    expectedFrameOriginsJson: values.get('--expected-frame-origins-json'),
    unlistedVenueSlug: values.get('--unlisted-venue-slug'),
    timeoutMs: values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : 5_000,
  }
}

export function validateStagingWidgetInputs(input) {
  let healthUrl
  let expectedRevision
  try {
    healthUrl = validateStagingHealthUrl(input.healthUrl)
    expectedRevision = validateReleaseSha(input.expectedRevision)
  } catch (error) {
    if (error instanceof StagingHealthAdmissionError) fail(error.code)
    throw error
  }
  if (input.confirmEnvironment !== 'staging') fail('missing-staging-confirmation')

  const health = new URL(healthUrl)
  const hostname = health.hostname
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
    .toLowerCase()
  const host = health.port === '' ? hostname : `${hostname}:${health.port}`
  if (input.confirmHost !== host) fail('host-confirmation-mismatch')
  const venueSlug = validateVenueSlug(input.venueSlug)
  const unlistedVenueSlug = validateVenueSlug(input.unlistedVenueSlug)
  if (venueSlug === unlistedVenueSlug) fail('control-venue-slug-not-distinct')

  return {
    healthUrl,
    expectedRevision,
    confirmEnvironment: 'staging',
    confirmHost: host,
    expectedResources: input.expectedResources,
    venueSlug,
    expectedFrameOrigins: parseExpectedFrameOrigins(input.expectedFrameOriginsJson),
    unlistedVenueSlug,
    timeoutMs: validateTimeout(input.timeoutMs ?? 5_000),
  }
}

export async function readReviewedWidgetSource(
  expectedRevision,
  { root = resolve(import.meta.dirname, '../..'), spawn = spawnSync } = {},
) {
  validateReleaseSha(expectedRevision)
  const object = `${expectedRevision}:${WIDGET_SOURCE_PATH}`
  const exists = spawn('git', ['cat-file', '-e', object], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
  })
  if (exists.status !== 0) fail('reviewed-widget-source-missing')

  const source = spawn('git', ['show', object], {
    cwd: root,
    encoding: null,
    maxBuffer: MAX_WIDGET_BYTES + 1,
    timeout: 5_000,
  })
  if (source.status !== 0 || !(source.stdout instanceof Uint8Array)) {
    fail('reviewed-widget-source-read-failed')
  }
  return validateWidgetSource(source.stdout)
}

export async function readReviewedWidgetStyles(
  expectedRevision,
  { root = resolve(import.meta.dirname, '../..'), spawn = spawnSync } = {},
) {
  validateReleaseSha(expectedRevision)
  const object = `${expectedRevision}:${WIDGET_STYLE_PATH}`
  const exists = spawn('git', ['cat-file', '-e', object], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
  })
  if (exists.status !== 0) fail('reviewed-widget-styles-missing')

  const source = spawn('git', ['show', object], {
    cwd: root,
    encoding: null,
    maxBuffer: MAX_WIDGET_STYLE_BYTES + 1,
    timeout: 5_000,
  })
  if (source.status !== 0 || !(source.stdout instanceof Uint8Array)) {
    fail('reviewed-widget-styles-read-failed')
  }
  return validateWidgetStyles(source.stdout)
}

export async function verifyStagingWidget({
  reviewedWidgetSource,
  reviewedWidgetStyles,
  fetchImpl = globalThis.fetch,
  ...rawInput
}) {
  const input = validateStagingWidgetInputs(rawInput)
  const expectedWidgetBytes = validateWidgetSource(reviewedWidgetSource)
  const expectedWidgetStyleBytes = validateWidgetStyles(reviewedWidgetStyles)
  if (typeof fetchImpl !== 'function') fail('fetch-unavailable')

  const healthInput = {
    healthUrl: input.healthUrl,
    expectedRevision: input.expectedRevision,
    confirmEnvironment: input.confirmEnvironment,
    confirmHost: input.confirmHost,
    expectedResources: input.expectedResources,
    timeoutMs: input.timeoutMs,
    fetchImpl,
  }
  try {
    await verifyStagingHealth(healthInput)
  } catch (error) {
    if (error instanceof StagingHealthAdmissionError) fail(`health-before-${error.code}`)
    throw error
  }

  const origin = new URL(input.healthUrl).origin
  const widgetUrl = `${origin}/widget.js`
  const { response: widgetResponse, signal: widgetSignal } = await fetchSameOrigin(widgetUrl, {
    accept: 'application/javascript, text/javascript;q=0.9',
    fetchImpl,
    timeoutMs: input.timeoutMs,
  })
  if (widgetResponse.status !== 200) failResponse(widgetResponse, 'widget-http-status')
  const widgetContentType = (widgetResponse.headers.get('content-type') ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (!['application/javascript', 'text/javascript'].includes(widgetContentType)) {
    failResponse(widgetResponse, 'widget-content-type')
  }
  const widgetCache = widgetResponse.headers.get('cache-control') ?? ''
  if (
    !hasDirective(widgetCache, 'public') ||
    !hasDirective(widgetCache, 'max-age=0') ||
    !hasDirective(widgetCache, 'must-revalidate') ||
    hasDirective(widgetCache, 'immutable')
  ) {
    failResponse(widgetResponse, 'widget-cache-policy')
  }
  if ((widgetResponse.headers.get('x-content-type-options') ?? '').toLowerCase() !== 'nosniff') {
    failResponse(widgetResponse, 'widget-content-type-policy')
  }
  if ((widgetResponse.headers.get('cross-origin-resource-policy') ?? '') !== 'cross-origin') {
    failResponse(widgetResponse, 'widget-cross-origin-policy')
  }
  const remoteWidgetBytes = await readBoundedBody(widgetResponse, widgetSignal, MAX_WIDGET_BYTES)
  if (
    remoteWidgetBytes.byteLength !== expectedWidgetBytes.byteLength ||
    remoteWidgetBytes.some((value, index) => value !== expectedWidgetBytes[index])
  ) {
    fail('widget-source-mismatch')
  }

  const styleUrl = `${origin}/widget.css`
  const { response: styleResponse, signal: styleSignal } = await fetchSameOrigin(styleUrl, {
    accept: 'text/css',
    fetchImpl,
    timeoutMs: input.timeoutMs,
  })
  if (styleResponse.status !== 200) failResponse(styleResponse, 'widget-style-http-status')
  if (
    (styleResponse.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() !==
    'text/css'
  ) {
    failResponse(styleResponse, 'widget-style-content-type')
  }
  const styleCache = styleResponse.headers.get('cache-control') ?? ''
  if (
    !hasDirective(styleCache, 'public') ||
    !hasDirective(styleCache, 'max-age=0') ||
    !hasDirective(styleCache, 'must-revalidate') ||
    hasDirective(styleCache, 'immutable')
  ) {
    failResponse(styleResponse, 'widget-style-cache-policy')
  }
  if ((styleResponse.headers.get('cross-origin-resource-policy') ?? '') !== 'cross-origin') {
    failResponse(styleResponse, 'widget-style-cross-origin-policy')
  }
  if ((styleResponse.headers.get('x-content-type-options') ?? '').toLowerCase() !== 'nosniff') {
    failResponse(styleResponse, 'widget-style-content-type-policy')
  }
  const remoteWidgetStyleBytes = await readBoundedBody(
    styleResponse,
    styleSignal,
    MAX_WIDGET_STYLE_BYTES,
  )
  if (
    remoteWidgetStyleBytes.byteLength !== expectedWidgetStyleBytes.byteLength ||
    remoteWidgetStyleBytes.some((value, index) => value !== expectedWidgetStyleBytes[index])
  ) {
    fail('widget-style-source-mismatch')
  }

  const readyUrl = `${origin}/api/widget-ready/${input.venueSlug}`
  const { response: readyResponse } = await fetchSameOrigin(readyUrl, {
    accept: '*/*',
    fetchImpl,
    timeoutMs: input.timeoutMs,
  })
  if (readyResponse.status !== 204) failResponse(readyResponse, 'widget-ready-http-status')
  requireWidgetReadyHeaders(readyResponse, input.expectedRevision, true)
  void readyResponse.body?.cancel().catch(() => undefined)

  const unlistedReadyUrl = `${origin}/api/widget-ready/${input.unlistedVenueSlug}`
  const { response: unlistedReadyResponse } = await fetchSameOrigin(unlistedReadyUrl, {
    accept: '*/*',
    fetchImpl,
    timeoutMs: input.timeoutMs,
  })
  if (unlistedReadyResponse.status !== 404) {
    failResponse(unlistedReadyResponse, 'unlisted-widget-ready-http-status')
  }
  requireWidgetReadyHeaders(unlistedReadyResponse, input.expectedRevision, false)
  void unlistedReadyResponse.body?.cancel().catch(() => undefined)

  const embedUrl = `${origin}/embed/${input.venueSlug}`
  const { response: embedResponse } = await fetchSameOrigin(embedUrl, {
    accept: 'text/html',
    fetchImpl,
    timeoutMs: input.timeoutMs,
  })
  if (embedResponse.status !== 200) failResponse(embedResponse, 'embed-http-status')
  if (
    (embedResponse.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() !==
    'text/html'
  ) {
    failResponse(embedResponse, 'embed-content-type')
  }
  requireEmbedPrivacyHeaders(embedResponse, input.expectedRevision)
  void embedResponse.body?.cancel().catch(() => undefined)
  const framingOrigins = parseFrameAncestors(
    embedResponse.headers.get('content-security-policy') ?? '',
  )
  if (
    framingOrigins.length !== input.expectedFrameOrigins.length ||
    framingOrigins.some((originValue, index) => originValue !== input.expectedFrameOrigins[index])
  ) {
    fail('frame-origins-mismatch')
  }

  const queryUrl = `${embedUrl}?chrome=hidden`
  const { response: queryResponse } = await fetchSameOrigin(queryUrl, {
    accept: 'text/html',
    fetchImpl,
    timeoutMs: input.timeoutMs,
  })
  if (queryResponse.status !== 200) failResponse(queryResponse, 'query-control-http-status')
  requireEmbedPrivacyHeaders(queryResponse, input.expectedRevision)
  void queryResponse.body?.cancel().catch(() => undefined)
  if ((queryResponse.headers.get('content-security-policy') ?? '') !== "frame-ancestors 'self'") {
    fail('query-control-not-self-only')
  }

  const unlistedUrl = `${origin}/embed/${input.unlistedVenueSlug}`
  const { response: unlistedResponse } = await fetchSameOrigin(unlistedUrl, {
    accept: 'text/html',
    fetchImpl,
    timeoutMs: input.timeoutMs,
  })
  if (unlistedResponse.status !== 404) {
    failResponse(unlistedResponse, 'unlisted-control-http-status')
  }
  requireEmbedPrivacyHeaders(unlistedResponse, input.expectedRevision)
  void unlistedResponse.body?.cancel().catch(() => undefined)
  if (
    (unlistedResponse.headers.get('content-security-policy') ?? '') !== "frame-ancestors 'self'"
  ) {
    fail('unlisted-control-not-self-only')
  }

  try {
    await verifyStagingHealth(healthInput)
  } catch (error) {
    if (error instanceof StagingHealthAdmissionError) fail(`health-after-${error.code}`)
    throw error
  }

  return {
    ok: true,
    host: input.confirmHost,
    revision: input.expectedRevision,
    venueSlug: input.venueSlug,
    frameOrigins: framingOrigins,
    unlistedVenueSlug: input.unlistedVenueSlug,
    unlistedReady: false,
    widgetSha256: createHash('sha256').update(remoteWidgetBytes).digest('hex'),
    widgetStyleSha256: createHash('sha256').update(remoteWidgetStyleBytes).digest('hex'),
    querySelfOnly: true,
    unlistedSelfOnly: true,
  }
}
