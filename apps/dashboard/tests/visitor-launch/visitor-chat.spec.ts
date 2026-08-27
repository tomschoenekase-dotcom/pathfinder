import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  return errors
}

async function hideFrameworkDevChrome(page: Page) {
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
}

async function expectViewportIntegrity(page: Page) {
  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    bodyHeight: document.body.scrollHeight,
    viewportHeight: window.innerHeight,
    scrollY: window.scrollY,
  }))
  expect(dimensions.bodyWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewportWidth + 1,
  )
  expect(dimensions.documentWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewportWidth + 1,
  )
  expect(dimensions.bodyHeight, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewportHeight + 1,
  )
  expect(dimensions.scrollY, JSON.stringify(dimensions)).toBe(0)
}

async function expectAccessiblePage(page: Page) {
  const result = await new AxeBuilder({ page }).include('body').analyze()
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([])
}

async function expectTouchTargets(page: Page) {
  const undersized = await page
    .locator('button:visible, a[href]:visible, select:visible, textarea:visible')
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            label:
              element.getAttribute('aria-label') ??
              element.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 80) ??
              element.tagName,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        })
        .filter(({ width, height }) => width < 44 || height < 44),
    )
  expect(undersized).toEqual([])
}

async function saveEvidence(page: Page, testInfo: TestInfo, name: string) {
  const screenshot = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath(`${name}.png`),
  })
  expect(screenshot.byteLength).toBeGreaterThan(2_000)
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
})

test('long RTL and CJK conversation remains usable while offline', async ({ page }, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=listening&conversation=multilingual&motion=reduced&network=offline&language=العربية',
  )
  await hideFrameworkDevChrome(page)

  const fixture = page.locator('[data-fixture="visitor-chat"]')
  await expect(fixture.locator(':scope > [dir="rtl"]')).toBeVisible()
  await expect(page.getByText(/هل يمكنك اقتراح/)).toBeVisible()
  await expect(page.getByText(/子どもと一緒に/)).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /غير متصل/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /الاتصال/ })).toBeDisabled()

  await expectViewportIntegrity(page)
  await expectTouchTargets(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'visitor-offline-multilingual')
  expect(runtimeErrors).toEqual([])
})

test('delayed response remains bounded and motion-safe', async ({ page }, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=thinking&conversation=long&motion=reduced&network=online&language=English',
  )
  await hideFrameworkDevChrome(page)

  await expect(page.locator('[data-fixture-state="thinking"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sending message' })).toBeDisabled()
  const activeAnimations = await page.locator('[class*="animate-"]').evaluateAll((elements) =>
    elements
      .map((element) => ({
        className: element.getAttribute('class'),
        animationName: window.getComputedStyle(element).animationName,
      }))
      .filter(({ animationName }) => animationName !== 'none'),
  )
  expect(activeAnimations).toEqual([])

  await expectViewportIntegrity(page)
  await expectTouchTargets(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'visitor-delayed-response')
  expect(runtimeErrors).toEqual([])
})

test('localized loading surface remains launch-safe', async ({ page }, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto('/dev-fixtures/visitor-chat?surface=loading&language=العربية')
  await hideFrameworkDevChrome(page)
  await expect(page.getByRole('status')).toHaveAttribute('dir', 'rtl')
  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'visitor-loading-arabic')
  expect(runtimeErrors).toEqual([])
})

test('localized error recovery remains keyboard reachable', async ({ page }, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto('/dev-fixtures/visitor-chat?surface=error&language=日本語')
  await hideFrameworkDevChrome(page)
  await expect(
    page.getByRole('alert').filter({ hasText: 'This venue link is not active.' }),
  ).toBeVisible()
  const retry = page.getByRole('button')
  await expect(retry).toHaveCount(1)
  await retry.focus()
  await expect(retry).toBeFocused()
  await expectViewportIntegrity(page)
  await expectTouchTargets(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'visitor-error-japanese')
  expect(runtimeErrors).toEqual([])
})
