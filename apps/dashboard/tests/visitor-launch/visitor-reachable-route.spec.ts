import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('finds a reviewed restroom route with keyboard and localized mobile controls', async ({
  page,
}, testInfo) => {
  await page.goto('/dev-fixtures/reachable-route')
  await page.getByRole('button', { name: 'Plan a route' }).click()
  const restroom = page.getByRole('button', { name: 'Find a reachable restroom' })
  await restroom.focus()
  await restroom.press('Enter')
  await expect(page.getByText('Main entrance to Garden restrooms')).toBeVisible()
  await expect(
    page.getByText('Follow the garden walkway to the restrooms beside the courtyard.'),
  ).toBeVisible()
  expect(await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth)).toBe(true)
  const axe = await new AxeBuilder({ page }).include('main').analyze()
  expect(axe.violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('reachable-restroom.png'), fullPage: true })
  await page.getByLabel('Fixture language').selectOption('Français')
  await expect(
    page.getByRole('button', { name: 'Trouver des toilettes accessibles par un itinéraire' }),
  ).toBeVisible()
  expect(await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth)).toBe(true)
  await page.getByLabel('Fixture language').selectOption('العربية')
  await expect(page.locator('section[dir="rtl"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ابحث عن دورة مياه لها مسار متاح' })).toBeVisible()
  expect(await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('reachable-restroom-rtl.png'), fullPage: true })
})
