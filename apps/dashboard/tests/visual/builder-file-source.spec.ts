import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  return errors
}

test('verified file source remains truthful, readable, and non-authoritative', async ({
  page,
}, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/intake-builder-file-source`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

  await expect(page.locator('[data-fixture="intake-builder-file-source"]')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Extract · blocked' })).toBeVisible()
  await expect(page.getByText('Verified file source')).toBeVisible()
  await expect(
    page.getByText(/reviewed extraction before it can construct a package/),
  ).toBeVisible()
  await expect(page.getByText('c'.repeat(64))).toBeVisible()
  await expect(page.getByRole('button', { name: /approve|apply|publish/i })).toHaveCount(0)

  await expect
    .poll(() => page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1))
    .toBe(true)
  const axe = await new AxeBuilder({ page }).include('body').analyze()
  expect(
    axe.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([])
  expect(runtimeErrors).toEqual([])

  await testInfo.attach(`builder-file-source-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
})
