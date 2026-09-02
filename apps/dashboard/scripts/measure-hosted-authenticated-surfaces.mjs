import { createHash } from 'node:crypto'
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

import { admitHostedHealth } from './hosted-golden-venue-smoke.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../../..')
const FULL_SHA = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const SAFE_ROUTE = /^\/admin(?:\/[a-z0-9-]+)*\/?$/u
const DEFAULT_ROUTES = ['/admin/operations', '/admin/directory', '/admin/prospects/outreach']
const VIEWPORTS = [
  { name: 'phone-390x844', width: 390, height: 844 },
  { name: 'desktop-1440x1000', width: 1440, height: 1000 },
]

function fail(code) {
  throw new Error(code)
}

export function validateAuthenticatedSurfaceRoute(value) {
  if (!SAFE_ROUTE.test(value ?? '')) fail('unsafe-authenticated-route')
  const parsed = new URL(value, 'https://dashboard.example.test')
  if (parsed.search || parsed.hash || parsed.pathname !== value) fail('unsafe-authenticated-route')
  return value
}

export function resolveSessionStatePath(value) {
  if (!value) fail('session-state-required')
  const resolved = path.resolve(value)
  const relative = path.relative(repositoryRoot, resolved)
  if (
    (!relative.startsWith('..') && !path.isAbsolute(relative)) ||
    path.extname(resolved) !== '.json'
  )
    fail('session-state-must-be-external-json')
  return resolved
}

export function parseHostedAuthenticatedSurfaceArgs(args) {
  const values = new Map()
  const routes = []
  const allowed = new Set([
    '--revision',
    '--session-state',
    '--route',
    '--ack-sensitive-local-artifacts',
  ])
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!allowed.has(option)) fail('unknown-option')
    if (value === undefined || value.startsWith('--')) fail('missing-option-value')
    if (option === '--route') {
      routes.push(validateAuthenticatedSurfaceRoute(value))
      continue
    }
    if (values.has(option)) fail('duplicate-option')
    values.set(option, value)
  }
  const revision = values.get('--revision')
  if (!revision || !FULL_SHA.test(revision)) fail('exact-revision-required')
  if (values.get('--ack-sensitive-local-artifacts') !== 'yes')
    fail('sensitive-local-artifact-acknowledgement-required')
  const selectedRoutes = routes.length > 0 ? routes : DEFAULT_ROUTES
  if (selectedRoutes.length > 8 || new Set(selectedRoutes).size !== selectedRoutes.length)
    fail('invalid-authenticated-route-set')
  return {
    revision,
    sessionState: resolveSessionStatePath(values.get('--session-state')),
    routes: selectedRoutes,
  }
}

export function validateAuthenticatedDashboardPolicy(policy) {
  let dashboardUrl
  try {
    dashboardUrl = new URL(policy?.dashboardUrl ?? '')
  } catch {
    fail('staging-dashboard-policy-origin-invalid')
  }
  if (
    dashboardUrl.protocol !== 'https:' ||
    dashboardUrl.hostname !== policy?.dashboardHost ||
    dashboardUrl.username ||
    dashboardUrl.password ||
    dashboardUrl.search ||
    dashboardUrl.hash ||
    dashboardUrl.pathname !== '/'
  )
    fail('staging-dashboard-policy-origin-invalid')
  return dashboardUrl.origin
}

export function authenticatedSurfaceArtifactDirectory(revision) {
  if (!FULL_SHA.test(revision)) fail('exact-revision-required')
  return path.join(repositoryRoot, 'artifacts', 'hosted-authenticated-surfaces', revision)
}

function fingerprint(kind, message) {
  return {
    kind,
    utf8Bytes: Buffer.byteLength(message, 'utf8'),
    sha256: createHash('sha256').update(message).digest('hex'),
  }
}

function routeSlug(route) {
  return route.replace(/^\/+|\/+$/gu, '').replaceAll('/', '--') || 'root'
}

export function validateAuthenticatedSurfaceSamples(samples, expectedOrigin, expectedCount) {
  if (samples.length !== expectedCount) fail('authenticated-surface-sample-count-mismatch')
  for (const sample of samples) {
    if (sample.finalOrigin !== expectedOrigin) fail('authenticated-surface-cross-origin-redirect')
    if (sample.finalPath === '/sign-in' || sample.finalPath.startsWith('/sign-in/'))
      fail('authenticated-session-unavailable')
    if (sample.finalPath !== sample.requestedRoute) fail('authenticated-surface-route-mismatch')
    if (!sample.mainLandmarkPresent) fail('authenticated-surface-main-landmark-missing')
    if (sample.browserErrors.length > 0) fail('authenticated-surface-browser-errors')
    if (!SHA256.test(sample.screenshotSha256) || sample.screenshotBytes < 1)
      fail('authenticated-surface-screenshot-missing')
  }
}

async function measureSurface(browser, origin, sessionState, route, viewport, outputDirectory) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    storageState: sessionState,
  })
  const page = await context.newPage()
  const browserErrors = []
  const requestMethods = new Map()
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(fingerprint('console-error', message.text()))
  })
  page.on('pageerror', (error) => browserErrors.push(fingerprint('page-error', error.message)))
  page.on('request', (request) => {
    const method = request.method()
    requestMethods.set(method, (requestMethods.get(method) ?? 0) + 1)
  })
  try {
    const response = await page.goto(`${origin}${route}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    if (!response?.ok()) fail('authenticated-surface-request-failed')
    await page.waitForLoadState('load', { timeout: 60_000 })
    await page.waitForTimeout(2_000)
    const location = new URL(page.url())
    const mainLandmarkPresent = (await page.locator('main').count()) > 0
    const screenshotName = `${routeSlug(route)}--${viewport.name}.png`
    const screenshotPath = path.join(outputDirectory, screenshotName)
    await page.screenshot({ path: screenshotPath, fullPage: true })
    const screenshot = await readFile(screenshotPath)
    return {
      requestedRoute: route,
      viewport,
      finalOrigin: location.origin,
      finalPath: location.pathname,
      mainLandmarkPresent,
      browserErrors,
      requestMethods: Object.fromEntries(
        [...requestMethods].sort(([left], [right]) => left.localeCompare(right)),
      ),
      screenshot: path.relative(repositoryRoot, screenshotPath).replaceAll('\\', '/'),
      screenshotBytes: screenshot.length,
      screenshotSha256: createHash('sha256').update(screenshot).digest('hex'),
    }
  } finally {
    await context.close()
  }
}

export async function runHostedAuthenticatedSurfaceMeasurement(options) {
  if (process.env.PATHFINDER_ALLOW_AUTHENTICATED_HOSTED_CAPTURE !== '1')
    fail('authenticated-hosted-capture-disabled')
  await access(options.sessionState)
  if ((await lstat(options.sessionState)).isSymbolicLink()) fail('session-state-symlink-rejected')
  const canonicalSessionState = await realpath(options.sessionState)
  const canonicalRelative = path.relative(repositoryRoot, canonicalSessionState)
  if (!canonicalRelative.startsWith('..') || path.extname(canonicalSessionState) !== '.json')
    fail('session-state-must-be-external-json')
  const policy = JSON.parse(
    await readFile(path.join(repositoryRoot, 'scripts/release-verification-policy.json'), 'utf8'),
  ).staging
  const origin = validateAuthenticatedDashboardPolicy(policy)
  await admitHostedHealth(policy, options.revision)

  const outputDirectory = authenticatedSurfaceArtifactDirectory(options.revision)
  await mkdir(outputDirectory, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const samples = []
  try {
    for (const route of options.routes) {
      for (const viewport of VIEWPORTS)
        samples.push(
          await measureSurface(
            browser,
            origin,
            canonicalSessionState,
            route,
            viewport,
            outputDirectory,
          ),
        )
    }
  } finally {
    await browser.close()
  }
  validateAuthenticatedSurfaceSamples(samples, origin, options.routes.length * VIEWPORTS.length)

  const report = {
    schemaVersion: 1,
    kind: 'torchiko-hosted-authenticated-surface-pixels',
    generatedAt: new Date().toISOString(),
    revision: options.revision,
    origin,
    authenticatedRouteObserved: true,
    authenticationInference: 'same-origin protected route loaded without a sign-in redirect',
    passiveNavigationOnly: true,
    interactionPerformed: false,
    sessionStateRetained: false,
    potentiallySensitiveLocalArtifacts: true,
    routes: options.routes,
    viewports: VIEWPORTS,
    samples,
    limitations: [
      'An authorized exported Clerk session is required; this harness never creates or bypasses identity.',
      'Screenshots remain local and gitignored because authenticated surfaces can contain sensitive staging data.',
      'Passive navigation proves rendered pixels only; it does not authorize or execute provider calls, customer contact, publication, billing, or production changes.',
      'Observed request methods are retained as counts only and do not prove representative database latency or absence of application telemetry.',
    ],
  }
  const reportPath = path.join(outputDirectory, 'report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      report: path.relative(repositoryRoot, reportPath).replaceAll('\\', '/'),
      revision: options.revision,
      routes: options.routes.length,
      screenshots: samples.length,
    })}\n`,
  )
  return report
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  try {
    await runHostedAuthenticatedSurfaceMeasurement(
      parseHostedAuthenticatedSurfaceArgs(process.argv.slice(2)),
    )
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(error.message)
        ? error.message
        : 'unexpected-failure'
    process.stderr.write(`Hosted authenticated surface measurement failed: ${code}\n`)
    process.exitCode = 1
  }
}
