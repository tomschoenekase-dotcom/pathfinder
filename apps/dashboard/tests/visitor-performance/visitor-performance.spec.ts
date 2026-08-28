import { expect, test, type Browser } from '@playwright/test'

const fixturePath =
  '/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=empty&motion=reduced&network=online&language=English'
const visitorPath = process.env.PLAYWRIGHT_VISITOR_PATH ?? fixturePath
const requestedSamples = Number.parseInt(process.env.VISITOR_PERFORMANCE_SAMPLES ?? '3', 10)
const sampleCount = Number.isSafeInteger(requestedSamples)
  ? Math.min(10, Math.max(1, requestedSamples))
  : 3

type LongTaskEntry = { duration: number; startTime: number }

declare global {
  interface Window {
    __pathfinderLongTasks?: LongTaskEntry[]
  }
}

function nearestRankPercentile(values: number[], percentile: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * percentile) - 1] ?? 0
}

async function measureSample(browser: Browser, networkProfile: string) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  })
  const page = await context.newPage()

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
          window.__pathfinderLongTasks?.push(
            ...list.getEntries().map((entry) => ({
              duration: Math.round(entry.duration),
              startTime: Math.round(entry.startTime),
            })),
          )
        }).observe({ type: 'longtask', buffered: true })
      } catch {
        // An empty list honestly reports browsers without Long Task API support.
      }
    })

    const startedAt = Date.now()
    const response = await page.goto(visitorPath, { waitUntil: 'domcontentloaded' })
    expect(response?.ok()).toBe(true)

    const composer = page.locator('#chat-input')
    await expect(composer).toBeVisible()
    await expect(composer).toBeEnabled()
    const interactionReadyMs = Date.now() - startedAt

    // Let deferred chunks and venue assets settle without invoking the chat mutation.
    await page.waitForLoadState('load')
    await page.waitForTimeout(1_000)

    return await page.evaluate((readyMs) => {
      const navigation = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      const aggregate = (entries: PerformanceResourceTiming[]) => ({
        requests: entries.length,
        transferBytes: entries.reduce((total, entry) => total + entry.transferSize, 0),
        encodedBodyBytes: entries.reduce((total, entry) => total + entry.encodedBodySize, 0),
        decodedBodyBytes: entries.reduce((total, entry) => total + entry.decodedBodySize, 0),
      })
      const longTasks = window.__pathfinderLongTasks ?? []

      return {
        interactionReadyMs: readyMs,
        navigation: navigation
          ? {
              responseStartMs: Math.round(navigation.responseStart),
              domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
              loadEventMs: Math.round(navigation.loadEventEnd),
              documentTransferBytes: navigation.transferSize,
              documentEncodedBodyBytes: navigation.encodedBodySize,
            }
          : null,
        allResources: aggregate(resources),
        scripts: aggregate(resources.filter((entry) => entry.initiatorType === 'script')),
        styles: aggregate(
          resources.filter((entry) => entry.initiatorType === 'css' || entry.name.includes('.css')),
        ),
        images: aggregate(resources.filter((entry) => entry.initiatorType === 'img')),
        longTasks: {
          count: longTasks.length,
          totalDurationMs: longTasks.reduce((total, entry) => total + entry.duration, 0),
          longestMs: Math.max(0, ...longTasks.map((entry) => entry.duration)),
        },
      }
    }, interactionReadyMs)
  } finally {
    await context.close()
  }
}

test('records visitor readiness distributions without sending chat', async ({
  browser,
}, testInfo) => {
  const networkProfile = String(testInfo.project.metadata.networkProfile ?? 'unthrottled')
  const samples = []
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await measureSample(browser, networkProfile))
  }

  const readinessValues = samples.map((sample) => sample.interactionReadyMs)
  const metrics = {
    schemaVersion: 2,
    measuredAt: new Date().toISOString(),
    revision: process.env.PATHFINDER_RELEASE_SHA ?? null,
    networkProfile,
    networkConditions:
      networkProfile === 'weak-4g' ? { latencyMs: 150, downloadMbps: 1.6, uploadKbps: 750 } : null,
    sampleCount,
    url: new URL(visitorPath, String(testInfo.project.use.baseURL)).toString(),
    viewport: { width: 390, height: 844 },
    chatRequestsSent: 0,
    interactionReadyMs: {
      minimum: Math.min(...readinessValues),
      p50: nearestRankPercentile(readinessValues, 0.5),
      p95: nearestRankPercentile(readinessValues, 0.95),
      maximum: Math.max(...readinessValues),
    },
    streamingTtft: {
      measured: false,
      reason:
        'Guest chat supports SSE token streaming and records provider/request first-text timing, but this provider-dark readiness run intentionally sends zero chat requests.',
    },
    samples,
  }

  const body = Buffer.from(`${JSON.stringify(metrics, null, 2)}\n`)
  await testInfo.attach('visitor-performance-metrics', {
    body,
    contentType: 'application/json',
  })
  console.log(`VISITOR_PERFORMANCE_METRICS=${JSON.stringify(metrics)}`)

  expect(samples).toHaveLength(sampleCount)
  expect(samples.every((sample) => sample.allResources.requests > 0)).toBe(true)
  expect(metrics.chatRequestsSent).toBe(0)
})
