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

test('staff interview clarification stays scoped, readable, and keyboard reachable', async ({
  page,
}) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/intake-builder-interview-clarification`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

  await expect(
    page.locator('[data-fixture="intake-builder-interview-clarification"]'),
  ).toBeVisible()
  await expect(page.getByText('Staff answers remain evidence, not venue truth.')).toBeVisible()
  await expect(page.getByText('Answer retained as guidance only:')).toBeVisible()
  await expect(page.getByText(/source amendment/)).toBeVisible()
  const queue = page.getByRole('button', { name: 'Queue founder clarification' })
  await queue.focus()
  await expect(queue).toBeFocused()
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
})
