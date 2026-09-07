import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('workflow records and decision controls remain readable across viewports', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'phone-390x844')
    await page.setViewportSize({ width: 320, height: 568 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${baseUrl}/dev-fixtures/agent-workflow-ledger`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  await expect(page.getByRole('heading', { name: 'Workflow activation ledger' })).toBeVisible()
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Decision reason (optional)')).toBeAttached()
  const decision = page.getByRole('button', { name: 'Record rejected decision' })
  await decision.focus()
  await expect(decision).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations.map(
      ({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }),
    ),
  ).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath(`workflow-ledger-${page.viewportSize()?.width}.png`),
    fullPage: true,
  })
})
