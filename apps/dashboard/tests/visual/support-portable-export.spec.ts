import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('support portable export fixture is focused, accessible, and responsive', async ({
  page,
}, testInfo) => {
  await page.route('**/admin/clients/fixture-tenant/support-export', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: '{"contentSha256":"a"}',
      headers: { 'Cache-Control': 'private, no-store' },
    }),
  )
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/support-portable-export`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('heading', { name: 'Portable client export' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Prepare JSON download' })).toBeDisabled()

  await expect
    .poll(() => page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1))
    .toBe(true)

  await page.getByLabel('Existing account recipient', { exact: true }).selectOption('fixture-owner')
  await page.getByLabel('Venue', { exact: true }).selectOption('fixture-riverside')
  await page.getByRole('checkbox', { name: /Current venue/ }).check()
  await expect(page.getByRole('button', { name: 'Prepare JSON download' })).toBeEnabled()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Prepare JSON download' }).click()
  expect((await download).suggestedFilename()).toBe('support-portable-export.json')
  await expect(page.getByRole('status')).toContainText('Prepared a scoped JSON download')

  const accessibility = await new AxeBuilder({ page }).include('main').analyze()
  expect(accessibility.violations).toEqual([])
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  await page.locator('main').screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath(`support-portable-export-${testInfo.project.name}.png`),
  })
})
