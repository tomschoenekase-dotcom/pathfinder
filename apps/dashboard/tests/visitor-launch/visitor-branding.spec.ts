import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('saved arrival branding loads below the primary action', async ({ page }, testInfo) => {
  // Synthetic layout evidence; public receipt/revocation is proven separately against PostgreSQL.
  const requestedAssets: string[] = []
  await page.route('**/dev-fixtures/visitor-brand-*.svg', async (route) => {
    requestedAssets.push(route.request().url())
    return route.fulfill({
      contentType: 'image/svg+xml',
      headers: { 'Cache-Control': 'private, max-age=0, no-store' },
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300" viewBox="0 0 900 300"><rect width="900" height="300" fill="#245a4a"/><path d="M0 180 Q225 80 450 180 T900 180 V300 H0Z" fill="#8db8a4"/><path d="M0 230 Q225 130 450 230 T900 230 V300 H0Z" fill="#bdd8cc"/></svg>',
    })
  })
  await page.goto('/dev-fixtures/venue-arrival?state=empty&theme=forest&branding=approved')
  await expect(page.locator('main img')).toHaveCount(2)
  await expect.poll(() => requestedAssets.length).toBe(2)
  for (const image of await page.locator('main img').all()) {
    await expect
      .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
  }
  const action = page.getByRole('link', { name: /Open your guide/u })
  const actionBounds = await action.boundingBox()
  const bannerBounds = await page.locator('img[src*="visitor-brand-banner"]').boundingBox()
  expect(bannerBounds!.y).toBeGreaterThan(actionBounds!.y + actionBounds!.height)
  expect(actionBounds!.height).toBeGreaterThanOrEqual(44)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath('arrival-approved-branding.png'),
    fullPage: true,
  })
})

test('a fresh branding delivery failure preserves arrival actions', async ({ page }) => {
  const requestedAssets: string[] = []
  await page.route('**/dev-fixtures/visitor-brand-*.svg', async (route) => {
    requestedAssets.push(route.request().url())
    await route.fulfill({
      status: 404,
      headers: { 'Cache-Control': 'private, max-age=0, no-store' },
      body: '',
    })
  })
  await page.goto('/dev-fixtures/venue-arrival?state=empty&theme=forest&branding=approved')

  const action = page.getByRole('link', { name: /Open your guide/u })
  await expect(page.locator('main img')).toHaveCount(0)
  await expect.poll(() => requestedAssets.length).toBe(2)
  await expect(action).toHaveAttribute('href', '/great-lakes-museum/chat')
  await action.focus()
  await expect(action).toBeFocused()
})
