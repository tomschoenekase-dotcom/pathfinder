import { writeFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Route } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'
const origin = new URL(dashboardBaseUrl)
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
  throw new Error('Character runtime proof requires an isolated loopback dashboard')
}

type BrowserImageObservations = { errors: number; failedImages: HTMLImageElement[] }
type ObservedWindow = Window & { characterRuntimeImages: BrowserImageObservations }

test.use({ serviceWorkers: 'block' })

for (const viewport of [
  { width: 320, height: 740 },
  { width: 820, height: 1180 },
  { width: 1024, height: 900 },
  { width: 1440, height: 900 },
]) {
  test(`character runtime failure isolation at ${viewport.width}px`, async ({ page }, testInfo) => {
    test.setTimeout(180_000)
    await page.setViewportSize(viewport)
    const pageErrors: string[] = []
    const externalAttempts: string[] = []
    const imageRequests: string[] = []
    const imageHttpErrors: string[] = []
    const imageNetworkFailures: string[] = []
    const pending: Route[] = []
    const observations: unknown[] = []
    let navigationDurationMs = 0

    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('request', (request) => {
      if (request.resourceType() === 'image') imageRequests.push(new URL(request.url()).pathname)
    })
    page.on('response', (response) => {
      if (response.request().resourceType() === 'image' && response.status() >= 400) {
        imageHttpErrors.push(new URL(response.url()).pathname)
      }
    })
    page.on('requestfailed', (request) => {
      if (request.resourceType() === 'image')
        imageNetworkFailures.push(new URL(request.url()).pathname)
    })
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== origin.origin) {
        externalAttempts.push(`${url.origin}${url.pathname}`)
        await route.abort('blockedbyclient')
      } else if (url.pathname.startsWith('/__character-runtime-delayed__/')) {
        pending.push(route)
      } else if (/^\/missing-(layer|fallback)-/.test(url.pathname)) {
        await route.fulfill({ status: 404, contentType: 'image/svg+xml', body: '' })
      } else {
        await route.continue()
      }
    })
    await page.addInitScript(() => {
      const observed = window as unknown as ObservedWindow
      observed.characterRuntimeImages = { errors: 0, failedImages: [] }
      window.addEventListener(
        'error',
        (event) => {
          if (event.target instanceof HTMLImageElement) {
            observed.characterRuntimeImages.errors++
            observed.characterRuntimeImages.failedImages.push(event.target)
          }
        },
        true,
      )
    })

    const rigs = page.locator('[data-rig-family]')
    const grid = page.locator('[data-fixture-ready]')
    async function navigate(query: string) {
      const started = performance.now()
      await page.goto(`${dashboardBaseUrl}/dev-fixtures/character-family-rigs?${query}`, {
        waitUntil: 'domcontentloaded',
      })
      await expect(grid).toHaveAttribute('data-fixture-ready', 'true')
      navigationDurationMs = Math.round((performance.now() - started) * 100) / 100
      await expect(rigs).toHaveCount(3)
    }
    async function healthyLayers() {
      await expect(rigs.locator('img')).toHaveCount(7)
      await expect
        .poll(() =>
          rigs.locator('img').evaluateAll((images) =>
            images.every((image) => {
              const img = image as HTMLImageElement
              return img.complete && img.naturalWidth > 0
            }),
          ),
        )
        .toBe(true)
      await expect(
        page.getByRole('img', { name: /Neutral owl:/ }).locator('[data-rig-layer="wing"]'),
      ).toBeVisible()
      await expect(
        page.getByRole('img', { name: /Neutral astronaut:/ }).locator('[data-rig-layer="head"]'),
      ).toBeVisible()
      await expect(
        page.getByRole('img', { name: /Neutral morph:/ }).locator('[data-rig-layer="face"]'),
      ).toBeVisible()
    }
    async function noAnimations() {
      expect(
        await rigs
          .locator('*')
          .evaluateAll((nodes) =>
            nodes.every((node) => getComputedStyle(node).animationName === 'none'),
          ),
      ).toBe(true)
    }
    async function record(state: string) {
      await page
        .locator('nextjs-portal')
        .evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
      const violations = (await new AxeBuilder({ page }).include('body').analyze()).violations
      const metrics = await page.evaluate(() => ({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        rigCount: document.querySelectorAll('[data-rig-family]').length,
        renderedImageCount: document.querySelectorAll('[data-rig-family] img').length,
        domImageErrors: (window as unknown as ObservedWindow).characterRuntimeImages.errors,
        horizontalOverflow:
          document.documentElement.scrollWidth > window.innerWidth + 1 ||
          document.body.scrollWidth > window.innerWidth + 1,
      }))
      const screenshot = await page.screenshot({
        animations: 'disabled',
        caret: 'hide',
        path: testInfo.outputPath(`${state}.png`),
        fullPage: true,
      })
      observations.push({
        state,
        ...metrics,
        navigationDurationMs,
        imageRequestCount: imageRequests.length,
        imageHttpErrorCount: imageHttpErrors.length,
        imageNetworkFailureCount: imageNetworkFailures.length,
        axeViolationCount: violations.length,
        pageErrors: [...pageErrors],
        fixtureNotifications: await grid.getAttribute('data-fixture-notifications'),
        lateNativeErrorsDelivered: await grid.getAttribute('data-fixture-late-deliveries'),
      })
      expect(screenshot.byteLength).toBeGreaterThan(10_000)
      expect(metrics.viewport.width).toBe(viewport.width)
      expect(metrics.horizontalOverflow).toBe(false)
      expect(violations).toEqual([])
      expect(pageErrors).toEqual([])
      expect(externalAttempts).toEqual([])
    }

    try {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await navigate('state=speaking')
      await healthyLayers()
      await record('normal')

      await navigate('state=speaking&motion=reduced')
      await healthyLayers()
      await expect(page.locator('[data-rig-motion="reduced"]')).toHaveCount(3)
      await noAnimations()
      await record('explicit-reduced')

      await page.emulateMedia({ reducedMotion: 'reduce' })
      await navigate('state=speaking&motion=system')
      await healthyLayers()
      await expect(page.locator('[data-rig-motion="system"]')).toHaveCount(3)
      await noAnimations()
      await record('system-reduced')

      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await navigate('state=error&failure=source')
      await expect(rigs.locator('img')).toHaveCount(3)
      await expect(grid).toHaveAttribute('data-fixture-notifications', '3')
      await noAnimations()
      await record('static-fallback')

      await navigate('state=error&failure=double')
      await expect(rigs.getByText('T', { exact: true })).toHaveCount(3)
      await expect(rigs.locator('img')).toHaveCount(0)
      await expect(grid).toHaveAttribute('data-fixture-notifications', '6')
      const fallbackRequests = imageRequests.filter((url) =>
        url.startsWith('/missing-fallback-'),
      ).length
      expect(fallbackRequests).toBe(3)
      await page.evaluate(async () => {
        const { failedImages } = (window as unknown as ObservedWindow).characterRuntimeImages
        for (const image of [...failedImages]) image.dispatchEvent(new Event('error'))
        await Promise.resolve()
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
      })
      await expect(rigs.locator('img')).toHaveCount(0)
      await expect(grid).toHaveAttribute('data-fixture-notifications', '6')
      await noAnimations()
      await record('double-failure')
      expect(imageRequests.filter((url) => url.startsWith('/missing-fallback-'))).toHaveLength(
        fallbackRequests,
      )

      await navigate('state=speaking&proof=isolation')
      await healthyLayers()
      await expect(grid).toHaveAttribute('data-fixture-notifications', '0')
      await page
        .locator('nextjs-portal')
        .evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
      await page.keyboard.press('Tab')
      await expect(
        page.getByRole('button', { name: 'Use delayed assets', exact: true }),
      ).toBeFocused()
      await page.keyboard.press('Enter')
      await expect.poll(() => pending.length).toBe(7)
      await page.keyboard.press('Tab')
      await expect(
        page.getByRole('button', { name: 'Use replacement assets', exact: true }),
      ).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(grid).toHaveAttribute('data-fixture-configuration', 'replacement')
      await healthyLayers()
      for (const route of pending.splice(0))
        await route.fulfill({ status: 404, contentType: 'image/svg+xml', body: '' })
      await page.keyboard.press('Tab')
      await expect(
        page.getByRole('button', { name: 'Deliver old image errors', exact: true }),
      ).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(grid).toHaveAttribute('data-fixture-late-deliveries', '7')
      await page.evaluate(async () => {
        await Promise.resolve()
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      await healthyLayers()
      await expect(grid).toHaveAttribute('data-fixture-notifications', '0')
      await record('replacement-after-late-errors')

      await page.keyboard.press('Tab')
      await expect(
        page.getByRole('button', { name: 'Retry original assets', exact: true }),
      ).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(grid).toHaveAttribute('data-fixture-configuration', 'normal')
      await healthyLayers()
      await expect(grid).toHaveAttribute('data-fixture-notifications', '0')
      await record('normal-recovery')
    } finally {
      await Promise.allSettled(pending.map((route) => route.abort()))
      await writeFile(
        testInfo.outputPath('observations.json'),
        JSON.stringify(
          {
            viewport,
            observations,
            pageErrors,
            externalAttempts,
            imageRequests,
            imageHttpErrors,
            imageNetworkFailures,
            measurementScope:
              'Local development fixture only. Network image counts exclude data-URL loads; DOM image completion is checked separately. Navigation includes hydration; later same-page states reuse that navigation duration. Native late events complement direct callback unit proof.',
          },
          null,
          2,
        ),
      )
    }
  })
}
