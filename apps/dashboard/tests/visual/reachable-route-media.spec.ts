import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_VISITOR_BASE_URL ?? 'http://127.0.0.1:3000'
const image =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="#e8eee8"/><rect x="190" y="60" width="260" height="220" fill="#507768"/><rect x="280" y="140" width="80" height="140" fill="#fdfbf5"/><text x="320" y="110" font-family="sans-serif" font-size="24" text-anchor="middle" fill="white">RESTROOMS</text></svg>'

test('reachable destination media stays subordinate to usable route directions', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'phone-390x844')
    await page.setViewportSize({ width: 320, height: 568 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/venue-media/fixture-route-photo*', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: image }),
  )
  await page.goto(`${baseUrl}/dev-fixtures/reachable-route`)
  await page.getByRole('button', { name: 'Plan a route' }).click()
  await page.getByRole('button', { name: 'Find a reachable restroom' }).click()
  const photo = page.getByRole('img', { name: 'Synthetic diagram of the garden restroom entrance' })
  await expect(photo).toBeVisible()
  await photo.scrollIntoViewIfNeeded()
  expect(await photo.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(640)
  await expect(
    page.getByText('Follow the garden walkway to the restrooms beside the courtyard.'),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath(`route-media-${page.viewportSize()?.width}.png`),
    fullPage: true,
  })
  if (testInfo.project.name === 'desktop-1440x900') {
    await page.setViewportSize({ width: 1024, height: 768 })
    await photo.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('route-media-1024.png'), fullPage: true })
  }
  await page.getByLabel('Use only connections marked accessible').check()
  await expect(photo).toHaveCount(0)
  await page.unroute('**/api/venue-media/fixture-route-photo*')
  await page.route('**/api/venue-media/fixture-route-photo*', (route) =>
    route.fulfill({ status: 404, body: '' }),
  )
  await page.getByRole('button', { name: 'Find a reachable restroom' }).click()
  await expect(photo).toHaveCount(0)
  await expect(
    page.getByText('Follow the garden walkway to the restrooms beside the courtyard.'),
  ).toBeVisible()
})
