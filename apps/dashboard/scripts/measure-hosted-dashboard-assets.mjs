import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

import { validateHostedHealth } from './hosted-golden-venue-smoke.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../../..')
const FULL_SHA = /^[0-9a-f]{40}$/u

function fail(code) {
  throw new Error(code)
}

export function parseHostedDashboardAssetArgs(args) {
  const values = new Map()
  const allowed = new Set(['--revision', '--samples', '--report'])
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!allowed.has(option)) fail('unknown-option')
    if (values.has(option)) fail('duplicate-option')
    if (value === undefined || value.startsWith('--')) fail('missing-option-value')
    values.set(option, value)
  }
  const revision = values.get('--revision')
  if (!revision || !FULL_SHA.test(revision)) fail('exact-revision-required')
  const requestedSamples = Number.parseInt(values.get('--samples') ?? '3', 10)
  if (!Number.isSafeInteger(requestedSamples) || requestedSamples < 1 || requestedSamples > 5)
    fail('samples-out-of-range')
  return { revision, samples: requestedSamples, report: values.get('--report') ?? null }
}

export function validateDashboardAssetPolicy(policy) {
  const dashboardUrl = new URL(policy?.dashboardUrl ?? '')
  if (
    dashboardUrl.protocol !== 'https:' ||
    dashboardUrl.hostname !== policy?.dashboardHost ||
    dashboardUrl.username ||
    dashboardUrl.password ||
    dashboardUrl.search ||
    dashboardUrl.hash ||
    dashboardUrl.pathname !== '/'
  ) {
    fail('staging-dashboard-policy-origin-invalid')
  }
  return dashboardUrl.origin
}

export function resolveHostedDashboardAssetReportPath(value, revision) {
  const fallback = `artifacts/hosted-dashboard-assets/${revision}.json`
  const resolved = path.resolve(repositoryRoot, value ?? fallback)
  const relative = path.relative(repositoryRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('unsafe-report-path')
  if (path.extname(resolved) !== '.json') fail('report-must-be-json')
  return resolved
}

function nearestRankPercentile(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * percentile) - 1] ?? 0
}

export function summarizeDashboardAssetSamples(samples) {
  const metrics = [
    'domContentLoadedMs',
    'loadEventMs',
    'sameOriginRequests',
    'sameOriginTransferBytes',
    'scriptRequests',
    'scriptTransferBytes',
  ]
  return Object.fromEntries(
    metrics.map((metric) => {
      const values = samples.map((sample) => sample[metric])
      return [
        metric,
        {
          minimum: Math.min(...values),
          p50: nearestRankPercentile(values, 0.5),
          p95: nearestRankPercentile(values, 0.95),
          maximum: Math.max(...values),
        },
      ]
    }),
  )
}

export function validateDashboardAssetSamples(samples) {
  if (samples.length < 1) fail('dashboard-shell-samples-missing')
  if (samples.some((sample) => sample.finalPath !== '/sign-in'))
    fail('dashboard-shell-sign-in-boundary-missing')
  if (samples.some((sample) => sample.browserErrors.length > 0))
    fail('dashboard-shell-browser-errors')
  if (
    samples.some(
      (sample) =>
        sample.sameOriginRequests < 1 ||
        sample.sameOriginTransferBytes < 1 ||
        sample.scriptRequests < 1 ||
        sample.scriptTransferBytes < 1,
    )
  )
    fail('dashboard-shell-transfer-evidence-missing')
}

function fingerprint(kind, message) {
  return {
    kind,
    utf8Bytes: Buffer.byteLength(message, 'utf8'),
    sha256: createHash('sha256').update(message).digest('hex'),
  }
}

async function measureSample(browser, origin) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  })
  const page = await context.newPage()
  const browserErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(fingerprint('console-error', message.text()))
  })
  page.on('pageerror', (error) => browserErrors.push(fingerprint('page-error', error.message)))

  try {
    const response = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    if (!response?.ok()) fail('dashboard-shell-request-failed')
    await page.waitForLoadState('load', { timeout: 60_000 })
    await page.waitForTimeout(2_000)
    return await page
      .evaluate((expectedOrigin) => {
        if (location.origin !== expectedOrigin)
          throw new Error('dashboard-shell-cross-origin-redirect')
        const navigation = performance.getEntriesByType('navigation')[0]
        const resources = performance.getEntriesByType('resource')
        const sameOrigin = resources.filter(
          (entry) => new URL(entry.name).origin === expectedOrigin,
        )
        const scripts = sameOrigin.filter((entry) => entry.initiatorType === 'script')
        return {
          finalPath: location.pathname,
          domContentLoadedMs: Math.round(navigation?.domContentLoadedEventEnd ?? 0),
          loadEventMs: Math.round(navigation?.loadEventEnd ?? 0),
          sameOriginRequests: sameOrigin.length,
          sameOriginTransferBytes: sameOrigin.reduce(
            (total, entry) => total + entry.transferSize,
            0,
          ),
          scriptRequests: scripts.length,
          scriptTransferBytes: scripts.reduce((total, entry) => total + entry.transferSize, 0),
          externalRequestCount: resources.length - sameOrigin.length,
        }
      }, origin)
      .then((sample) => ({ ...sample, browserErrors }))
  } finally {
    await context.close()
  }
}

export async function runHostedDashboardAssetMeasurement(options) {
  const policy = JSON.parse(
    await readFile(path.join(repositoryRoot, 'scripts/release-verification-policy.json'), 'utf8'),
  ).staging
  const origin = validateDashboardAssetPolicy(policy)
  const healthResponse = await fetch(policy.healthUrl, { signal: AbortSignal.timeout(30_000) })
  if (!healthResponse.ok) fail('staging-health-request-failed')
  validateHostedHealth(await healthResponse.json(), policy, options.revision)

  const browser = await chromium.launch({ headless: true })
  const samples = []
  try {
    for (let index = 0; index < options.samples; index += 1)
      samples.push(await measureSample(browser, origin))
  } finally {
    await browser.close()
  }
  validateDashboardAssetSamples(samples)

  const report = {
    schemaVersion: 1,
    kind: 'torchiko-hosted-dashboard-public-shell-assets',
    generatedAt: new Date().toISOString(),
    revision: options.revision,
    origin,
    authenticated: false,
    customerDataRead: false,
    cacheBoundary: 'fresh-browser-context-per-sample',
    viewport: { width: 1440, height: 1000 },
    sampleCount: samples.length,
    aggregates: summarizeDashboardAssetSamples(samples),
    samples,
    limitations: [
      'Public sign-in shell only; authenticated dashboard route chunks and pixels remain unmeasured.',
      'Transfer size is Chromium Resource Timing for the measured edge responses, not an SLO.',
      'No representative database query or customer-history latency is claimed.',
    ],
  }
  const outputPath = resolveHostedDashboardAssetReportPath(options.report, options.revision)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      report: path.relative(repositoryRoot, outputPath).replaceAll('\\', '/'),
      revision: options.revision,
      sampleCount: samples.length,
      scriptTransferBytesP50: report.aggregates.scriptTransferBytes.p50,
    })}\n`,
  )
  return report
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  try {
    await runHostedDashboardAssetMeasurement(parseHostedDashboardAssetArgs(process.argv.slice(2)))
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(error.message)
        ? error.message
        : 'unexpected-failure'
    process.stderr.write(`Hosted dashboard asset measurement failed: ${code}\n`)
    process.exitCode = 1
  }
}
