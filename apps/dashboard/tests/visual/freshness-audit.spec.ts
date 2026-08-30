import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('current-truth review states remain explicit and responsive', async ({ page }, testInfo) => {
  const runtimeErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`))
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/freshness-audit`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

  await expect(page.getByRole('heading', { name: 'Evidence review queue' })).toBeVisible()
  await expect(page.getByText('Expired · guest-hidden')).toBeVisible()
  await expect(page.getByText('Live · expires soon')).toBeVisible()
  await expect(page.getByText('Scheduled · expires soon')).toBeVisible()
  const questions = page.getByRole('link', { name: 'Agent questions' })
  await questions.focus()
  await expect(questions).toBeFocused()
  await expect
    .poll(() => page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1))
    .toBe(true)
  const accessibility = await new AxeBuilder({ page }).include('body').analyze()
  expect(accessibility.violations).toEqual([])
  const screenshot = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
    path: testInfo.outputPath('freshness-current-truth.png'),
  })
  expect(screenshot.byteLength).toBeGreaterThan(10_000)
  expect(runtimeErrors).toEqual([])
})
