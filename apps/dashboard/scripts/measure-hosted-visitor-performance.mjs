import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  const samples = Number(values.get('--samples') ?? '10')
  if (!revision || !FULL_SHA.test(revision)) fail('exact-revision-required')
  if (!SAFE_SLUG.test(venueSlug)) fail('unsafe-venue-slug')
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10) fail('samples-out-of-range')
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

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export function summarizeHostedVisitorSamples(samples) {
  const metrics = [
    'documentResponseMs',
    'navigationStartMs',
    'domContentLoadedMs',
    'loadEventMs',
    'composerVisibleMs',
    'sendReadyMs',
    'historyRequestStartMs',
    'historyResponseEndMs',
    'historyRequestDurationMs',
    'sessionRequestStartMs',
    'sessionResponseEndMs',
    'sessionRequestDurationMs',
    'transcriptMessageObservedMs',
    'resourceTransferBytes',
    'scriptTransferBytes',
    'longestLongTaskMs',
  ]
  return Object.fromEntries(
    metrics.map((metric) => {
      const values = samples
        .map((sample) => sample[metric])
        .filter((value) => typeof value === 'number' && Number.isFinite(value))
      return [
        metric,
        {
          observedCount: values.length,
          median: median(values),
          minimum: values.length ? Math.min(...values) : null,
          maximum: values.length ? Math.max(...values) : null,
        },
      ]
    }),
  )
}

export function validateHostedVisitorSamples(samples, expectedPath) {
  if (samples.length < 1) fail('visitor-samples-missing')
  if (samples.some((sample) => sample.finalPath !== expectedPath)) fail('visitor-route-mismatch')
  if (samples.some((sample) => sample.status !== 'passed')) fail('visitor-sample-failed')
  if (samples.some((sample) => sample.browserErrors.length > 0)) fail('visitor-browser-errors')
  if (
    samples.some(
      (sample) =>
        sample.sendReadyMs < 1 ||
        sample.resourceRequests < 1 ||
        sample.resourceTransferBytes < 1 ||
        sample.scriptRequests < 1 ||
        sample.scriptTransferBytes < 1,
    )
  )
    fail('visitor-transfer-evidence-missing')
}

export function hostedOperationNames(requestUrl) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname)
  } catch {
    return []
  }
  if (!pathname.includes('/api/trpc/')) return []
  return ['chat.history', 'chat.session'].filter((operation) => pathname.includes(operation))
}

function fingerprint(kind, message) {
  return {
    kind,
    utf8Bytes: Buffer.byteLength(message, 'utf8'),
    sha256: createHash('sha256').update(message).digest('hex'),
  }
}

async function measureNavigation(page, url, expectedPath, expectedOrigin, navigationKind) {
  const startedAt = Date.now()
  const capture = { startedAt, requests: [], browserErrors: [], lastRelevantActivityAt: startedAt }
  page.__hostedPerformanceCapture = capture
  const requestEvidence = new WeakMap()
  const relativeNow = () => Math.max(0, Date.now() - capture.startedAt)
  const finishRequest = (request, failureCode = null) => {
    const evidence = requestEvidence.get(request)
    if (!evidence || evidence.finishedAtMs !== null) return
    evidence.finishedAtMs = relativeNow()
    if (failureCode) evidence.failureCode = failureCode
    evidence.durationMs = Math.max(0, evidence.finishedAtMs - evidence.startedAtMs)
    capture.lastRelevantActivityAt = Date.now()
  }
  const onRequest = (request) => {
    const operations = hostedOperationNames(request.url())
    if (!operations.length) return
    const evidence = {
      operations,
      startedAtMs: relativeNow(),
      finishedAtMs: null,
      durationMs: null,
      status: null,
      failureCode: null,
    }
    capture.requests.push(evidence)
    requestEvidence.set(request, evidence)
    capture.lastRelevantActivityAt = Date.now()
  }
  const onResponse = (response) => {
    const evidence = requestEvidence.get(response.request())
    if (!evidence) return
    evidence.status = response.status()
    if (response.status() >= 400) evidence.failureCode = 'http-error'
  }
  const onRequestFinished = (request) => finishRequest(request)
  const onRequestFailed = (request) => finishRequest(request, 'request-failed')
  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfinished', onRequestFinished)
  page.on('requestfailed', onRequestFailed)

  let response = null
  let failureCode = null
  try {
    response =
      navigationKind === 'same-session-reload'
        ? await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
        : await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    if (!response?.ok()) fail('visitor-request-failed')
    const composer = page.locator('textarea[enterkeyhint="send"]')
    await composer.waitFor({ state: 'visible', timeout: 60_000 })
    const composerVisibleMs = relativeNow()
    const sendButton = composer.locator('xpath=..').locator('button[type="button"]')
    // A local draft exposes the actual send admission gate; the button is never clicked.
    if (navigationKind === 'first-visit') {
      await composer.fill('Performance harness draft (never sent).')
    } else {
      await page.waitForFunction(
        () =>
          document.querySelector('textarea[enterkeyhint="send"]')?.value ===
          'Performance harness draft (never sent).',
        undefined,
        { timeout: 5_000 },
      )
    }
    await sendButton.waitFor({ state: 'visible', timeout: 60_000 })
    await sendButton.waitFor({ state: 'attached', timeout: 60_000 })
    await page.waitForFunction(
      () => {
        const composerElement = document.querySelector('textarea[enterkeyhint="send"]')
        const sendButtonElement =
          composerElement?.parentElement?.querySelector('button[type="button"]')
        return Boolean(sendButtonElement && !sendButtonElement.disabled)
      },
      undefined,
      { timeout: 60_000 },
    )
    const sendReadyMs = relativeNow()
    await page.waitForLoadState('load', { timeout: 60_000 })

    const quietStartedAt = Date.now()
    while (
      Date.now() - quietStartedAt < 10_000 &&
      (capture.requests.some((request) => request.finishedAtMs === null) ||
        Date.now() - capture.lastRelevantActivityAt < 200)
    ) {
      await page.waitForTimeout(25)
    }

    const sample = await page.evaluate(
      ({ composerVisible, sendReady, origin }) => {
        if (location.origin !== origin) throw new Error('visitor-cross-origin-redirect')
        const navigation = performance.getEntriesByType('navigation')[0]
        const resources = performance.getEntriesByType('resource')
        const scripts = resources.filter((entry) => entry.initiatorType === 'script')
        const images = resources.filter((entry) => entry.initiatorType === 'img')
        const longTasks = window.__pathfinderLongTasks ?? []
        const conversation = document.querySelector('[role="log"]')
        const restoredMessages = conversation?.querySelectorAll('article').length ?? 0
        const transcriptObservedMs = window.__pathfinderLifecycle?.firstTranscriptMessageAtMs
        return {
          finalPath: location.pathname,
          documentResponseMs: Math.round(navigation?.responseStart ?? 0) || null,
          navigationStartMs: Math.round(navigation?.startTime ?? 0),
          domContentLoadedMs: Math.round(navigation?.domContentLoadedEventEnd ?? 0) || null,
          loadEventMs: Math.round(navigation?.loadEventEnd ?? 0) || null,
          composerVisibleMs: composerVisible,
          sendReadyMs: sendReady,
          restoredTranscriptMessageCount: restoredMessages,
          transcriptMessageObservedMs:
            typeof transcriptObservedMs === 'number' ? Math.round(transcriptObservedMs) : null,
          hydrationObserved: false,
          hydratedShellMs: null,
          resourceRequests: resources.length,
          resourceTransferBytes: resources.reduce((total, entry) => total + entry.transferSize, 0),
          scriptRequests: scripts.length,
          scriptTransferBytes: scripts.reduce((total, entry) => total + entry.transferSize, 0),
          imageRequests: images.length,
          imageTransferBytes: images.reduce((total, entry) => total + entry.transferSize, 0),
          longTaskCount: longTasks.length,
          longestLongTaskMs: Math.round(Math.max(0, ...longTasks)),
          visibleAlertCount: document.querySelectorAll('[role="alert"]').length,
        }
      },
      { composerVisible: composerVisibleMs, sendReady: sendReadyMs, origin: expectedOrigin },
    )
    if (sample.finalPath !== expectedPath) failureCode = 'visitor-route-mismatch'
    else if (capture.browserErrors.length > 0) failureCode = 'visitor-browser-errors'
    else if (capture.requests.some((request) => request.failureCode))
      failureCode = 'visitor-lifecycle-request-failed'
    return {
      navigationKind,
      status: failureCode ? 'failed' : 'passed',
      ...(failureCode ? { failureCode } : {}),
      ...sample,
      browserErrors: capture.browserErrors,
      lifecycleRequests: capture.requests,
      historyRequestStartMs:
        capture.requests.find((request) => request.operations.includes('chat.history'))
          ?.startedAtMs ?? null,
      historyResponseEndMs:
        capture.requests.find(
          (request) => request.operations.includes('chat.history') && request.finishedAtMs !== null,
        )?.finishedAtMs ?? null,
      historyRequestDurationMs:
        capture.requests.find(
          (request) => request.operations.includes('chat.history') && request.durationMs !== null,
        )?.durationMs ?? null,
      historyRequestCount: capture.requests.filter((request) =>
        request.operations.includes('chat.history'),
      ).length,
      sessionRequestStartMs:
        capture.requests.find((request) => request.operations.includes('chat.session'))
          ?.startedAtMs ?? null,
      sessionResponseEndMs:
        capture.requests.find(
          (request) => request.operations.includes('chat.session') && request.finishedAtMs !== null,
        )?.finishedAtMs ?? null,
      sessionRequestDurationMs:
        capture.requests.find(
          (request) => request.operations.includes('chat.session') && request.durationMs !== null,
        )?.durationMs ?? null,
      sessionRequestCount: capture.requests.filter((request) =>
        request.operations.includes('chat.session'),
      ).length,
      lifecycleRequestFailures: capture.requests.filter((request) => request.failureCode),
    }
  } catch (error) {
    failureCode =
      error instanceof Error && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(error.message)
        ? error.message
        : 'unexpected-failure'
    return {
      navigationKind,
      status: 'failed',
      failureCode,
      finalPath: (() => {
        try {
          return new URL(page.url()).pathname
        } catch {
          return null
        }
      })(),
      documentResponseMs: null,
      navigationStartMs: null,
      domContentLoadedMs: null,
      loadEventMs: null,
      composerVisibleMs: null,
      sendReadyMs: null,
      restoredTranscriptMessageCount: null,
      transcriptMessageObservedMs: null,
      hydrationObserved: false,
      resourceRequests: 0,
      resourceTransferBytes: 0,
      scriptRequests: 0,
      scriptTransferBytes: 0,
      imageRequests: 0,
      imageTransferBytes: 0,
      longTaskCount: 0,
      longestLongTaskMs: 0,
      visibleAlertCount: null,
      browserErrors: capture.browserErrors,
      lifecycleRequests: capture.requests,
      historyRequestStartMs: null,
      historyResponseEndMs: null,
      historyRequestDurationMs: null,
      historyRequestCount: capture.requests.filter((request) =>
        request.operations.includes('chat.history'),
      ).length,
      sessionRequestStartMs: null,
      sessionResponseEndMs: null,
      sessionRequestDurationMs: null,
      sessionRequestCount: 0,
      lifecycleRequestFailures: capture.requests.filter((request) => request.failureCode),
    }
  } finally {
    page.off('request', onRequest)
    page.off('response', onResponse)
    page.off('requestfinished', onRequestFinished)
    page.off('requestfailed', onRequestFailed)
  }
}

async function measurePair(browser, url, expectedPath, expectedOrigin, networkProfile) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error' && page.__hostedPerformanceCapture)
      page.__hostedPerformanceCapture.browserErrors.push(
        fingerprint('console-error', message.text()),
      )
  })
  page.on('pageerror', (error) => {
    if (page.__hostedPerformanceCapture)
      page.__hostedPerformanceCapture.browserErrors.push(fingerprint('page-error', error.message))
  })

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
      window.__pathfinderLifecycle = { firstTranscriptMessageAtMs: null }
      try {
        new PerformanceObserver((list) => {
          window.__pathfinderLongTasks.push(...list.getEntries().map((entry) => entry.duration))
        }).observe({ type: 'longtask', buffered: true })
      } catch {
        // An empty list truthfully reports unavailable Long Task API support.
      }
      const observeTranscript = () => {
        if (
          window.__pathfinderLifecycle.firstTranscriptMessageAtMs === null &&
          document.querySelector('[role="log"] article')
        ) {
          window.__pathfinderLifecycle.firstTranscriptMessageAtMs = performance.now()
        }
      }
      new MutationObserver(observeTranscript).observe(document, { childList: true, subtree: true })
      document.addEventListener('DOMContentLoaded', observeTranscript, { once: true })
    })
    const firstVisit = await measureNavigation(
      page,
      url,
      expectedPath,
      expectedOrigin,
      'first-visit',
    )
    const sameSessionReload = await measureNavigation(
      page,
      url,
      expectedPath,
      expectedOrigin,
      'same-session-reload',
    )
    return { firstVisit, sameSessionReload }
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
  const { admitHostedHealth } = await import('./hosted-golden-venue-smoke.mjs')
  await admitHostedHealth(policy, options.revision)

  const origin = healthUrl.origin
  const expectedPath = `/${options.venueSlug}/chat`
  const url = `${origin}${expectedPath}`
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ headless: true })
  const profiles = []
  try {
    for (const networkProfile of ['unthrottled', 'weak-4g']) {
      const pairs = []
      for (let index = 0; index < options.samples; index += 1) {
        const pair = await measurePair(browser, url, expectedPath, origin, networkProfile)
        pairs.push({ pairIndex: index + 1, ...pair })
      }
      const firstVisitSamples = pairs.map((pair) => pair.firstVisit)
      const reloadSamples = pairs.map((pair) => pair.sameSessionReload)
      const validationErrors = []
      for (const [kind, samples] of [
        ['first-visit', firstVisitSamples],
        ['same-session-reload', reloadSamples],
      ]) {
        try {
          validateHostedVisitorSamples(samples, expectedPath)
        } catch (error) {
          validationErrors.push({
            navigationKind: kind,
            code:
              error instanceof Error && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(error.message)
                ? error.message
                : 'unexpected-validation-failure',
          })
        }
      }
      profiles.push({
        networkProfile,
        status: validationErrors.length ? 'failed' : 'passed',
        networkConditions:
          networkProfile === 'weak-4g'
            ? { latencyMs: 150, downloadMbps: 1.6, uploadKbps: 750 }
            : null,
        validationErrors,
        navigations: {
          firstVisit: {
            aggregates: summarizeHostedVisitorSamples(firstVisitSamples),
            samples: firstVisitSamples,
          },
          sameSessionReload: {
            aggregates: summarizeHostedVisitorSamples(reloadSamples),
            samples: reloadSamples,
          },
        },
        pairs,
      })
    }
  } finally {
    await browser.close()
  }

  const report = {
    schemaVersion: 2,
    kind: 'torchiko-hosted-visitor-performance',
    generatedAt: new Date().toISOString(),
    revision: options.revision,
    url,
    viewport: { width: 390, height: 844 },
    pairedSampleCountPerProfile: options.samples,
    navigationPairing:
      'Each pair uses one browser context: initial visit followed by same-URL reload with its session storage retained.',
    chatRequestsSent: 0,
    providerCalls: 0,
    status: profiles.some((profile) => profile.status !== 'passed') ? 'failed' : 'passed',
    profiles,
    limitations: [
      'Chromium device-class evidence only; physical-device CPU and real-radio variance remain unmeasured.',
      'React/Next hydration has no safe external browser marker here. Composer visible/enabled is reported as send-ready evidence, not hydration completion.',
      'A fixed draft is typed only in the disposable browser context to enable the send gate; the harness never clicks Send and closes the context after the paired reload.',
      'History request timing is observed only when the browser URL names chat.history; batched tRPC operations share one network request span.',
      'A transcript message mutation is observed separately, but this no-send harness cannot prove that visible messages are complete or semantically restored from server history.',
      'No chat turn was sent, so first submitted turn, useful model text and completed answer timing remain unmeasured.',
      'No approved media asset was present in the empty starter state.',
      'Sample summaries use medians and observed minimum/maximum ranges; no tail percentile is reported.',
    ],
  }
  const outputPath = resolveHostedVisitorPerformanceReportPath(options.report, options.revision)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `${JSON.stringify({
      report: path.relative(repositoryRoot, outputPath).replaceAll('\\', '/'),
      revision: options.revision,
      pairedSampleCountPerProfile: options.samples,
      status: report.status,
      sendReadyMedianRangeMs: Object.fromEntries(
        profiles.map((profile) => [
          profile.networkProfile,
          {
            firstVisit: profile.navigations.firstVisit.aggregates.sendReadyMs,
            sameSessionReload: profile.navigations.sameSessionReload.aggregates.sendReadyMs,
          },
        ]),
      ),
    })}\n`,
  )
  return report
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  try {
    const report = await runHostedVisitorPerformanceMeasurement(
      parseHostedVisitorPerformanceArgs(process.argv.slice(2)),
    )
    if (report.status !== 'passed') process.exitCode = 1
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(error.message)
        ? error.message
        : 'unexpected-failure'
    process.stderr.write(`Hosted visitor performance measurement failed: ${code}\n`)
    process.exitCode = 1
  }
}
