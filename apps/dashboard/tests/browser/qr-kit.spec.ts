import { expect, test } from '@playwright/test'

test.describe('QR launch kit', () => {
  test('renders one venue-correct public target by default on desktop', async ({ page }) => {
    await page.goto('/dev-fixtures/qr-kit')

    await expect(page.getByRole('heading', { name: 'Harbor House QR kit' })).toBeVisible()
    await expect(
      page.getByText('https://guide.example.com/harbor-house/chat?source=qr'),
    ).toBeVisible()
    await expect(page.getByText(/item=place-tide-clock/)).toHaveCount(0)
    await expect(page.getByText(/prompt=Tell\+me\+about\+Tide\+Clock/)).toHaveCount(0)
    await expect(page.locator('svg:has(> title)')).toHaveCount(1)
    await expect(page.locator('svg:has(> title) > title')).toHaveText(
      'QR code for Harbor House visitor guide',
    )

    const dimensions = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      viewport: innerWidth,
    }))
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1)
  })

  test('keeps copy and print actions safe when browser capabilities fail', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'print', {
        configurable: true,
        value: () => document.documentElement.setAttribute('data-print-requested', 'true'),
      })
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    })
    await page.goto('/dev-fixtures/qr-kit')
    await expect(page.locator('html')).not.toHaveAttribute('data-print-requested', 'true')

    await page.getByRole('button', { name: 'Copy guest chat URL' }).first().click()
    await expect(page.locator('p[role="alert"]')).toHaveText(
      'Could not copy the guest chat URL. Try again or select the URL manually.',
    )
    await expect(page.getByRole('button', { name: 'Copy guest chat URL' }).first()).toBeEnabled()

    await page.getByRole('button', { name: 'Print QR sheets' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-print-requested', 'true')
    await expect(page.getByRole('button', { name: 'Print QR sheets' })).toBeVisible()
  })
})
