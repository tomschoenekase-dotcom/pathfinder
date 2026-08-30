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

test('founder question evidence remains readable and keyboard reachable', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/founder-question-evidence`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

  await expect(page.locator('[data-fixture="founder-question-evidence"]')).toBeVisible()
  await expect(page.getByText('Evidence', { exact: true })).toBeVisible()
  await expect(page.getByText('Proposed interpretation', { exact: true })).toBeVisible()
  await expect(page.getByText(/does not approve, apply, or publish/i)).toBeVisible()
  await expect(
    page.getByText('intake-review:fixture-interview:venue.operations.hours'),
  ).toBeVisible()
  const submit = page.getByRole('button', { name: 'Submit guidance' })
  await submit.focus()
  await expect(submit).toBeFocused()

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
  const screenshot = testInfo.outputPath('founder-question-evidence.png')
  await page.screenshot({ path: screenshot, fullPage: true })
  await testInfo.attach('rendered founder question evidence', {
    path: screenshot,
    contentType: 'image/png',
  })
})
