import { expect, test, type Browser, type Page } from '@playwright/test'

const fixturePath = '/dev-fixtures/dashboard-performance'
const dashboardPath = process.env.PLAYWRIGHT_DASHBOARD_PATH ?? fixturePath
const requestedSamples = Number.parseInt(process.env.DASHBOARD_PERFORMANCE_SAMPLES ?? '3', 10)
const sampleCount = Number.isSafeInteger(requestedSamples)
  ? Math.min(10, Math.max(1, requestedSamples))
  : 3

type View = 'directory' | 'venues' | 'analytics' | 'transcript'
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

async function selectView(page: Page, view: View) {
  const startedAt = performance.now()
  await page.locator(`[data-view-button="${view}"]`).click()
  await expect(page.locator(`[data-view="${view}"]`)).toBeVisible()
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  return Math.round(performance.now() - startedAt)
}

async function measureSample(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  })
  const page = await context.newPage()

  try {
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
        // Browsers without Long Task API support honestly report an empty list.
      }
    })

    const startedAt = performance.now()
    const response = await page.goto(dashboardPath, { waitUntil: 'domcontentloaded' })
    expect(response?.ok()).toBe(true)
    await expect(page.locator('[data-performance-ready]')).toBeVisible()
    await expect(page.locator('[data-view="directory"]')).toBeVisible()
    const coldReadyMs = Math.round(performance.now() - startedAt)

    expect(await page.locator('[data-view="directory"] tbody tr').count()).toBe(100)
    const switchMs = {
      venues: await selectView(page, 'venues'),
      analytics: await selectView(page, 'analytics'),
      transcript: await selectView(page, 'transcript'),
      directory: await selectView(page, 'directory'),
    }

    await selectView(page, 'venues')
    const venueCards = await page.locator('[data-view="venues"] article').count()
    await selectView(page, 'analytics')
    const sessionSummaries = await page.locator('[data-view="analytics"] article').count()
    await selectView(page, 'transcript')
    const transcriptMessages = await page.locator('[data-view="transcript"] article').count()
    await page.waitForTimeout(250)

    return await page.evaluate(
      ({ readyMs, switching, counts }) => {
        const navigation = performance.getEntriesByType('navigation')[0] as
          | PerformanceNavigationTiming
          | undefined
        const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
        const scripts = resources.filter((entry) => entry.initiatorType === 'script')
        const longTasks = window.__pathfinderLongTasks ?? []
        return {
          coldReadyMs: readyMs,
          switchMs: switching,
          counts,
          domElements: document.querySelectorAll('*').length,
          navigation: navigation
            ? {
                responseStartMs: Math.round(navigation.responseStart),
                domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
                loadEventMs: Math.round(navigation.loadEventEnd),
                transferBytes: navigation.transferSize,
              }
            : null,
          resources: {
            requests: resources.length,
            transferBytes: resources.reduce((total, entry) => total + entry.transferSize, 0),
          },
          scripts: {
            requests: scripts.length,
            transferBytes: scripts.reduce((total, entry) => total + entry.transferSize, 0),
          },
          longTasks: {
            count: longTasks.length,
            totalDurationMs: longTasks.reduce((total, entry) => total + entry.duration, 0),
            longestMs: Math.max(0, ...longTasks.map((entry) => entry.duration)),
          },
        }
      },
      {
        readyMs: coldReadyMs,
        switching: switchMs,
        counts: {
          clients: 100,
          venues: venueCards,
          sessions: sessionSummaries,
          messages: transcriptMessages,
        },
      },
    )
  } finally {
    await context.close()
  }
}

test('records bounded high-volume dashboard readiness and switching distributions', async ({
  browser,
}, testInfo) => {
  const samples = []
  for (let index = 0; index < sampleCount; index += 1) samples.push(await measureSample(browser))

  const coldValues = samples.map((sample) => sample.coldReadyMs)
  const switchValues = samples.flatMap((sample) => Object.values(sample.switchMs))
  const metrics = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    revision: process.env.PATHFINDER_RELEASE_SHA ?? null,
    sampleCount,
    url: new URL(dashboardPath, String(testInfo.project.use.baseURL)).toString(),
    viewport: { width: 1440, height: 1000 },
    fixtureBounds: {
      clients: 100,
      venues: 60,
      analyticsSessions: 20,
      transcriptPage: 50,
      transcriptTotal: 2400,
    },
    coldReadyMs: {
      minimum: Math.min(...coldValues),
      p50: nearestRankPercentile(coldValues, 0.5),
      p95: nearestRankPercentile(coldValues, 0.95),
      maximum: Math.max(...coldValues),
    },
    switchMs: {
      minimum: Math.min(...switchValues),
      p50: nearestRankPercentile(switchValues, 0.5),
      p95: nearestRankPercentile(switchValues, 0.95),
      maximum: Math.max(...switchValues),
    },
    samples,
  }

  await testInfo.attach('dashboard-performance-metrics', {
    body: Buffer.from(`${JSON.stringify(metrics, null, 2)}\n`),
    contentType: 'application/json',
  })
  console.log(`DASHBOARD_PERFORMANCE_METRICS=${JSON.stringify(metrics)}`)

  expect(samples).toHaveLength(sampleCount)
  expect(samples.every((sample) => sample.counts.venues === 60)).toBe(true)
  expect(samples.every((sample) => sample.counts.sessions === 20)).toBe(true)
  expect(samples.every((sample) => sample.counts.messages === 50)).toBe(true)
})

test('keeps high-volume views usable at desktop and compact widths', async ({
  browser,
}, testInfo) => {
  for (const viewport of [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'compact', width: 768, height: 900 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    })
    const page = await context.newPage()
    try {
      await page.goto(dashboardPath, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-performance-ready]')).toBeVisible()
      for (const view of ['directory', 'venues', 'analytics', 'transcript'] as const) {
        await selectView(page, view)
        const documentOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(
          documentOverflow,
          `${viewport.name} ${view} horizontal overflow`,
        ).toBeLessThanOrEqual(1)
      }
      const screenshotPath = testInfo.outputPath(`${viewport.name}-transcript.png`)
      await page.screenshot({ path: screenshotPath, fullPage: false })
      await testInfo.attach(`${viewport.name}-transcript`, {
        path: screenshotPath,
        contentType: 'image/png',
      })
    } finally {
      await context.close()
    }
  }
})
