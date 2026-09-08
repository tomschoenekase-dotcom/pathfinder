import { expect, test } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('conversation learning review remains usable at the configured viewport', async ({
  page,
}, testInfo) => {
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/conversation-learning`)
  await expect(
    page.locator('[data-fixture="conversation-learning"][data-hydrated="true"]'),
  ).toBeVisible()
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

test('accepted candidate proposal draft preserves edits through failure and remains review-only', async ({
  page,
}, testInfo) => {
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/conversation-learning`)
  await expect(
    page.locator('[data-fixture="conversation-learning"][data-hydrated="true"]'),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Scoped proposal handoff' })).toBeVisible()
  await expect(page.getByText('Scoped source messages')).toBeVisible()

  await page.getByText('Prepare proposal draft').click()
  const proposedChange = page.getByLabel('Proposed canonical change')
  const reason = page.getByLabel('Evidence-based reason')
  await expect(proposedChange).toHaveValue('')
  await expect(reason).toHaveValue('Needs a second source before proposal.')
  await expect(page.getByText(/candidate is still unverified/i)).toBeVisible()

  await proposedChange.fill('Add the reviewed alternate name to the model railway entry.')
  await reason.fill('Confirmed against the reviewed exhibit inventory.')
  await page.getByRole('button', { name: 'Create proposal draft' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Your entries are still here' }),
  ).toBeVisible()
  await expect(proposedChange).toHaveValue(
    'Add the reviewed alternate name to the model railway entry.',
  )
  await expect(reason).toHaveValue('Confirmed against the reviewed exhibit inventory.')

  await page.getByRole('button', { name: 'Create proposal draft' }).click()
  await expect(page.getByRole('button', { name: 'Creating draft…' })).toBeDisabled()
  await expect(proposedChange).toBeDisabled()
  await expect(reason).toBeDisabled()
  await expect(page.getByRole('status')).toContainText('Venue knowledge was not changed')
  const recorded = page.getByTestId('recorded-proposal-draft')
  await expect(recorded).toContainText('Recorded status: DRAFT')
  await expect(recorded).toContainText(
    'Proposed change: Add the reviewed alternate name to the model railway entry.',
  )
  await expect(recorded).toContainText('Reason: Confirmed against the reviewed exhibit inventory.')
  await expect(recorded).toContainText('No approval or guide publication occurred.')

  const capturedAtUtc = new Date().toISOString().replaceAll(':', '-')
  await page.screenshot({
    path: testInfo.outputPath(
      `conversation-learning-proposal-${testInfo.project.name}-${capturedAtUtc}.png`,
    ),
    fullPage: true,
  })
})
