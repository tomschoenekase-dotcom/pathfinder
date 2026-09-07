import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('workflow records and decision controls remain readable across viewports', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'phone-390x844')
    await page.setViewportSize({ width: 320, height: 568 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/trpc/admin.getAgentIdentity**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ result: { data: { json: { agentType: 'QUALITY_REVIEW' } } } }),
    }),
  )
  await page.goto(`${baseUrl}/dev-fixtures/agent-workflow-ledger`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  await expect(page.getByRole('heading', { name: 'Workflow activation ledger' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Review a workflow canary' })).toBeVisible()
  const requestApproval = page.getByRole('button', { name: 'Request human approval' })
  await expect(requestApproval).toBeDisabled()
  await page.getByLabel('Candidate version').selectOption('11111111-1111-4111-8111-111111111111')
  await page.getByLabel('Bookkeeping identity').selectOption('identity-fixture')
  await expect(page.getByText(/Development: 12 cases/)).toBeVisible()
  await expect(page.getByText(/Eligible run type: QUALITY_REVIEW/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply reviewed activate' })).toBeVisible()
  await expect(page.getByText('Applied · revision 7')).toBeVisible()
  await page.getByText('Review approval terms').first().click()
  await expect(page.getByText('Expected head revision').first()).toBeVisible()
  await expect(
    page
      .getByText('fixture-visible-selection-salt-with-a-long-reviewable-value-1234567890')
      .first(),
  ).toBeVisible()
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
