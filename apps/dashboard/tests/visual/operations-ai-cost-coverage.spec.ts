import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('AI cost coverage remains explicit at compact and desktop widths', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'phone-390x844')
    await page.setViewportSize({ width: 320, height: 568 })
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/agent-trust-evidence`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  await expect(page.getByText('Partial observed AI estimate')).toBeVisible()
  await expect(page.getByText('$74.25')).toBeVisible()
  await expect(page.getByText(/Totals are partial/)).toBeVisible()
  await expect(page.getByText('Coverage incomplete')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([])
  await page.locator('#cost-coverage').screenshot({
    path: testInfo.outputPath(`ai-cost-coverage-${page.viewportSize()?.width}.png`),
  })
})
