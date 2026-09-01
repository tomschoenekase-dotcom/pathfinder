import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  return errors
}

test('AI cost coverage remains truthful and usable across real browser widths', async ({
  page,
}, testInfo: TestInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/ai-cost-budget`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

  await expect(page.getByRole('heading', { name: 'AI cost budget' })).toBeVisible()
  await expect(page.getByText(/including venue-scoped and tenant-wide generation/)).toBeVisible()
  await expect(page.getByText(/remain(?:s)? explicitly outside/i)).toHaveCount(0)
  await expect(page.getByLabel('Hard limit (USD)')).toBeEditable()
  await expect
    .poll(() => page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1))
    .toBe(true)

  const accessibility = await new AxeBuilder({ page }).include('body').analyze()
  expect(
    accessibility.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([])
  expect(runtimeErrors).toEqual([])

  const screenshot = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath('ai-cost-budget.png'),
  })
  expect(screenshot.byteLength).toBeGreaterThan(10_000)
})
