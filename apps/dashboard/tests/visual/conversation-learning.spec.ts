import { expect, test } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('conversation learning review remains usable at the configured viewport', async ({
  page,
}, testInfo) => {
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/conversation-learning`)
  await expect(page.locator('[data-fixture="conversation-learning"]')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Conversation candidates' })).toBeVisible()
  await expect(page.getByText('Unverified · Visitor').first()).toBeVisible()
  await expect(page.getByText('Unverified · Authenticated employee')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept for proposal' }).first()).toBeVisible()
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'hidden')
  await page.screenshot({
    path: testInfo.outputPath(`conversation-learning-${testInfo.project.name}.png`),
    fullPage: true,
  })
})
