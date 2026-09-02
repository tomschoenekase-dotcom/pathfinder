import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

import { admitHostedHealth } from './hosted-golden-venue-smoke.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../../..')
const FULL_SHA = /^[0-9a-f]{40}$/u
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u

function fail(code) {
  throw new Error(code)
}

export function parseHostedVisitorPerformanceArgs(args) {
  const values = new Map()
  const allowed = new Set(['--revision', '--venue-slug', '--samples', '--report'])
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!allowed.has(option)) fail('unknown-option')
    if (values.has(option)) fail('duplicate-option')
    if (value === undefined || value.startsWith('--')) fail('missing-option-value')
    values.set(option, value)
  }
  const revision = values.get('--revision')
  const venueSlug = values.get('--venue-slug') ?? 'riverside-aquarium'
  const samples = Number.parseInt(values.get('--samples') ?? '3', 10)
  if (!revision || !FULL_SHA.test(revision)) fail('exact-revision-required')
  if (!SAFE_SLUG.test(venueSlug)) fail('unsafe-venue-slug')
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 5) fail('samples-out-of-range')
  return { revision, venueSlug, samples, report: values.get('--report') ?? null }
}

export function resolveHostedVisitorPerformanceReportPath(value, revision) {
  const fallback = `artifacts/hosted-visitor-performance/${revision}.json`
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

export function summarizeHostedVisitorSamples(samples) {
  const metrics = [
    'interactionReadyMs',
    'domContentLoadedMs',
    'loadEventMs',
    'resourceTransferBytes',
    'scriptTransferBytes',
    'longestLongTaskMs',
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

export function validateHostedVisitorSamples(samples, expectedPath) {
  if (samples.length < 1) fail('visitor-samples-missing')
  if (samples.some((sample) => sample.finalPath !== expectedPath)) fail('visitor-route-mismatch')
  if (samples.some((sample) => sample.browserErrors.length > 0)) fail('visitor-browser-errors')
  if (
    samples.some(
      (sample) =>
        sample.interactionReadyMs < 1 ||
        sample.resourceRequests < 1 ||
        sample.resourceTransferBytes < 1 ||
        sample.scriptRequests < 1 ||
        sample.scriptTransferBytes < 1,
    )
  )
    fail('visitor-transfer-evidence-missing')
}

function fingerprint(kind, message) {
  return {
    kind,
    utf8Bytes: Buffer.byteLength(message, 'utf8'),
    sha256: createHash('sha256').update(message).digest('hex'),
  }
}

async function measureSample(browser, url, expectedOrigin, networkProfile) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
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
    if (networkProfile === 'weak-4g') {
      const session = await context.newCDPSession(page)
      await session.send('Network.enable')
      await session.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
        connectionType: 'cellular4g',
      })
    }
    await page.addInitScript(() => {
      window.__pathfinderLongTasks = []
      try {
        new PerformanceObserver((list) => {
          window.__pathfinderLongTasks.push(...list.getEntries().map((entry) => entry.duration))
        }).observe({ type: 'longtask', buffered: true })
      } catch {
        // An empty list truthfully reports unavailable Long Task API support.
      }
    })

    const startedAt = Date.now()
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    if (!response?.ok()) fail('visitor-request-failed')
    const composer = page.locator('#chat-input')
    await composer.waitFor({ state: 'visible', timeout: 60_000 })
    if (!(await composer.isEnabled())) fail('visitor-composer-disabled')
    const interactionReadyMs = Date.now() - startedAt
    await page.waitForLoadState('load', { timeout: 60_000 })
    await page.waitForTimeout(1_000)

    return await page
      .evaluate(
        ({ readyMs, origin }) => {
          if (location.origin !== origin) throw new Error('visitor-cross-origin-redirect')
          const navigation = performance.getEntriesByType('navigation')[0]
          const resources = performance.getEntriesByType('resource')
          const scripts = resources.filter((entry) => entry.initiatorType === 'script')
          const images = resources.filter((entry) => entry.initiatorType === 'img')
          const longTasks = window.__pathfinderLongTasks ?? []
          return {
            finalPath: location.pathname,
            interactionReadyMs: readyMs,
            domContentLoadedMs: Math.round(navigation?.domContentLoadedEventEnd ?? 0),
            loadEventMs: Math.round(navigation?.loadEventEnd ?? 0),
            resourceRequests: resources.length,
            resourceTransferBytes: resources.reduce(
              (total, entry) => total + entry.transferSize,
              0,
            ),
            scriptRequests: scripts.length,
            scriptTransferBytes: scripts.reduce((total, entry) => total + entry.transferSize, 0),
            imageRequests: images.length,
            imageTransferBytes: images.reduce((total, entry) => total + entry.transferSize, 0),
            longTaskCount: longTasks.length,
            longestLongTaskMs: Math.round(Math.max(0, ...longTasks)),
          }
        },
        { readyMs: interactionReadyMs, origin: expectedOrigin },
      )
      .then((sample) => ({ ...sample, browserErrors }))
  } finally {
    await context.close()
  }
}

export async function runHostedVisitorPerformanceMeasurement(options) {
  const policy = JSON.parse(
    await readFile(path.join(repositoryRoot, 'scripts/release-verification-policy.json'), 'utf8'),
  ).staging
  const healthUrl = new URL(policy.healthUrl)
  if (healthUrl.protocol !== 'https:' || healthUrl.hostname !== policy.host)
    fail('staging-policy-origin-invalid')
  await admitHostedHealth(policy, options.revision)

  const origin = healthUrl.origin
  const expectedPath = `/${options.venueSlug}/chat`
  const url = `${origin}${expectedPath}`
  const browser = await chromium.launch({ headless: true })
  const profiles = []
  try {
    for (const networkProfile of ['unthrottled', 'weak-4g']) {
      const samples = []
      for (let index = 0; index < options.samples; index += 1)
        samples.push(await measureSample(browser, url, origin, networkProfile))
      validateHostedVisitorSamples(samples, expectedPath)
      profiles.push({
        networkProfile,
        networkConditions:
          networkProfile === 'weak-4g'
            ? { latencyMs: 150, downloadMbps: 1.6, uploadKbps: 750 }
            : null,
        aggregates: summarizeHostedVisitorSamples(samples),
        samples,
      })
    }
  } finally {
    await browser.close()
  }

  const report = {
    schemaVersion: 1,
    kind: 'torchiko-hosted-visitor-performance',
    generatedAt: new Date().toISOString(),
    revision: options.revision,
    url,
    viewport: { width: 390, height: 844 },
    sampleCountPerProfile: options.samples,
    chatRequestsSent: 0,
    providerCalls: 0,
    profiles,
    limitations: [
      'Chromium device-class evidence only; physical-device CPU and real-radio variance remain unmeasured.',
      'No chat turn was sent, so provider-backed time to first token and total response time remain unmeasured.',
      'No approved media asset was present in the empty starter state.',
    ],
  }
  const outputPath = resolveHostedVisitorPerformanceReportPath(options.report, options.revision)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      report: path.relative(repositoryRoot, outputPath).replaceAll('\\', '/'),
      revision: options.revision,
      sampleCountPerProfile: options.samples,
      interactionReadyP95Ms: Object.fromEntries(
        profiles.map((profile) => [
          profile.networkProfile,
          profile.aggregates.interactionReadyMs.p95,
        ]),
      ),
    })}\n`,
  )
  return report
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  try {
    await runHostedVisitorPerformanceMeasurement(
      parseHostedVisitorPerformanceArgs(process.argv.slice(2)),
    )
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(error.message)
        ? error.message
        : 'unexpected-failure'
    process.stderr.write(`Hosted visitor performance measurement failed: ${code}\n`)
    process.exitCode = 1
  }
}
