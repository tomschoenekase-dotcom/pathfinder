import { expect, test, type Page } from '@playwright/test'

const runtimeErrors = new WeakMap<Page, string[]>()

test.describe('client visitor chat customization fixture', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    runtimeErrors.set(page, errors)
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.goto('/dev-fixtures/chat-design')
    await expect(page.getByRole('heading', { name: 'Customize the visitor chat' })).toBeVisible()
  })

  test.afterEach(async ({ page }) => {
    expect(runtimeErrors.get(page) ?? []).toEqual([])
  })

  test('saves preset, accent, and font for venue A and restores them after venue switching', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Sunset' }).click()
    await page.getByRole('button', { name: 'Poppins' }).click()
    await page.getByLabel('Custom accent colour').fill('#ABCDEF')
    await page.getByLabel('logo asset').selectOption({ label: 'Harbor House mark' })
    await page.getByLabel('banner asset').selectOption({ label: 'Harbor House banner' })
    await page.getByRole('button', { name: 'Save design' }).click()
    await expect(page.getByRole('status')).toContainText('Design saved')
    await expect(page.getByLabel('logo asset')).toHaveValue('fixture-logo-derivative')
    await expect(page.getByLabel('banner asset')).toHaveValue('fixture-banner-derivative')

    await page.getByLabel('Venue').selectOption({ label: 'Civic Gallery' })
    await expect(page.getByLabel('Custom accent colour')).toHaveValue('')
    await page.getByLabel('Venue').selectOption({ label: 'Harbor House' })

    await expect(page.getByRole('button', { name: 'Sunset' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByRole('button', { name: 'Poppins' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByLabel('Custom accent colour')).toHaveValue('#ABCDEF')
    await expect(page.getByLabel('logo asset')).toHaveValue('fixture-logo-derivative')
    await expect(page.getByLabel('banner asset')).toHaveValue('fixture-banner-derivative')

    await page.reload()
    await expect(page.getByRole('button', { name: 'Sunset' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByRole('button', { name: 'Poppins' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByLabel('Custom accent colour')).toHaveValue('#ABCDEF')
    await expect(page.getByLabel('logo asset')).toHaveValue('fixture-logo-derivative')
    await expect(page.getByLabel('banner asset')).toHaveValue('fixture-banner-derivative')
  })

  test('keeps STAFF presentation read-only', async ({ page }) => {
    await page.goto('/dev-fixtures/chat-design?role=staff')
    await expect(page.getByText(/only venue managers and owners can edit/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save design' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Sunset' })).toBeDisabled()
    await expect(page.getByRole('switch', { name: 'Use dark mode' })).toBeDisabled()
    await expect(page.getByLabel('Custom accent colour')).toBeDisabled()
  })
})
