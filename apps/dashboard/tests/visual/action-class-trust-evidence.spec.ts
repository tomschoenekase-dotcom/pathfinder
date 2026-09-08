import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('action-class trust evidence is scoped, readable, and keyboard operable', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/agent-trust-evidence`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

  const panel = page.locator('[data-fixture-panel="action-class-trust-evidence"]')
  await expect(panel).toBeVisible()
  const disclosure = panel.locator('summary').first()
  await disclosure.focus()
  await expect(disclosure).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(panel.getByText('tenant_harbor_museum')).toBeVisible()
  await expect(panel.getByText('venue_north_gallery')).toBeVisible()
  await expect(panel.getByText('agent_support_drafter')).toBeVisible()
  await expect(panel.getByText('Inspect adverse evidence')).toBeVisible()
  await expect(panel.getByText('Unlinked outcomes: 1')).toBeVisible()
  await expect(panel.getByText('Scope mismatches: 0')).toBeVisible()
  await expect(
    panel.getByText(/no reliability score or authority change is inferred/i),
  ).toBeVisible()
  await expect(panel.getByRole('button')).toHaveCount(0)

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([])
  await panel.screenshot({
    path: testInfo.outputPath(`action-class-trust-evidence-${page.viewportSize()?.width}.png`),
  })
})
