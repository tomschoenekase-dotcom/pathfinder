import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

for (const viewport of [
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'tablet-820', width: 820, height: 1180 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
] as const) {
  test(`portal entry and shared client QR controls work at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(() => {
      Object.defineProperty(window, 'print', {
        configurable: true,
        value: () => document.documentElement.setAttribute('data-print-requested', 'true'),
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            document.documentElement.setAttribute('data-copied-url', value)
          },
        },
      })
    })
    await page.goto('/dev-fixtures/portal-home?state=live')

    const qrLink = page.getByRole('link', { name: 'Open QR code' })
    await expect(qrLink).toHaveAttribute('href', '/venues/fixture-great-lakes-museum/qr-kit')
    await qrLink.focus()
    await expect(qrLink).toBeFocused()
    const launchSection = page.locator('section', {
      has: page.locator('#launch-materials-heading'),
    })
    await launchSection.scrollIntoViewIfNeeded()
    const homeDimensions = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      viewport: innerWidth,
    }))
    expect(homeDimensions.body).toBeLessThanOrEqual(homeDimensions.viewport + 1)
    const homeAccessibility = await new AxeBuilder({ page })
      .include('section:has(#launch-materials-heading)')
      .analyze()
    expect(homeAccessibility.violations).toEqual([])
    await page.screenshot({
      path: `artifacts/client-qr-final-proof/client-qr-home-${viewport.name}-${testInfo.project.name}.png`,
      fullPage: true,
    })

    // The authenticated server route is covered by the route tests. Mount the same production QR
    // component through the provider-dark fixture for responsive interaction checks.
    await page.goto('/dev-fixtures/qr-kit?audience=client')
    await expect(page.getByRole('heading', { name: 'Harbor House QR code' })).toBeVisible()
    await expect(page.getByText('Visitor access')).toBeVisible()
    await expect(page.getByText('Internal print tool')).toHaveCount(0)

    await page.getByRole('button', { name: 'Copy guest chat URL' }).first().click()
    await expect(page.getByRole('status')).toHaveText('Guest chat URL copied.')
    await expect(page.locator('html')).toHaveAttribute(
      'data-copied-url',
      'https://guide.example.com/harbor-house/chat?source=qr',
    )

    await expect(page.locator('svg:has(> title)')).toHaveCount(1)
    const printButton = page.getByRole('button', { name: 'Print QR code' })
    await printButton.focus()
    await expect(printButton).toBeFocused()
    await printButton.click()
    await expect(page.locator('html')).toHaveAttribute('data-print-requested', 'true')

    const dimensions = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      viewport: innerWidth,
    }))
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1)
    const accessibility = await new AxeBuilder({ page }).include('body').analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({
      path: `artifacts/client-qr-final-proof/client-qr-${viewport.name}-${testInfo.project.name}.png`,
      fullPage: true,
    })
  })
}
