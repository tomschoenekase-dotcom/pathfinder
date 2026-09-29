import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const states = [
  'pending',
  'active',
  'past_due',
  'grace',
  'canceled',
  'manual',
  'complimentary',
] as const

for (const state of states) {
  test(`client billing ${state} is responsive and accessible`, async ({ page }) => {
    await page.goto(`/dev-fixtures/billing?surface=client&state=${state}`)
    await expect(
      page.getByRole('heading', {
        name: new RegExp(`client billing.*${state.replaceAll('_', ' ')}`, 'i'),
      }),
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Covered venues' })).toBeVisible()
    await expect(page.getByText('$50.00').first()).toBeVisible()
    const accessibility = await new AxeBuilder({ page }).include('main').analyze()
    expect(accessibility.violations).toEqual([])
    expect(
      await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth),
    ).toBe(true)
  })
}

test('a customer without a quote sees the next step, not an unavailable plan checkout', async ({
  page,
}) => {
  await page.goto('/dev-fixtures/billing?surface=client&state=empty')
  await expect(page.getByText(/agreed price and secure payment link/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose a plan' })).toHaveCount(0)
  const support = page.getByRole('link', { name: 'Contact Torchiko' })
  await support.focus()
  await expect(support).toBeFocused()
  expect(await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})

test('a past-due customer sees a payment-method action', async ({ page }) => {
  await page.goto('/dev-fixtures/billing?surface=client&state=past_due')
  const updatePayment = page.getByRole('button', { name: 'Update payment details' })
  await expect(updatePayment).toBeEnabled()
  await updatePayment.click()
  await expect(page.getByRole('status')).toContainText('Stripe Customer Portal would open')
})

test('payment actions are keyboard reachable and add-on interest never implies a charge', async ({
  page,
}) => {
  await page.goto('/dev-fixtures/billing?surface=client&state=active')
  const interested = page.getByRole('button', { name: "I'm interested" }).first()
  await interested.focus()
  await expect(interested).toBeFocused()
  await interested.press('Enter')
  await expect(page.getByRole('status')).toContainText('Nothing has been added or charged')
  const cancel = page.getByRole('button', { name: 'Cancel subscription' })
  await cancel.focus()
  await cancel.press('Enter')
  await expect(page.getByRole('dialog', { name: /cancel at the end/i })).toBeVisible()
  await page.getByLabel('Why are you canceling?').fill('The venue is closing for the season')
  await page.getByRole('button', { name: 'Schedule cancellation' }).click()
  await expect(page.getByRole('status')).toContainText('paid-through date')
})

test('operator billing warning state is accessible', async ({ page }) => {
  await page.goto('/dev-fixtures/billing?surface=admin&state=grace')
  await expect(page.getByText('Reconciliation warning', { exact: true })).toBeVisible()
  const accessibility = await new AxeBuilder({ page }).include('main').analyze()
  expect(accessibility.violations).toEqual([])
})
