import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('place mapping stays explicit and readable during location review', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'phone-390x844')
    await page.setViewportSize({ width: 320, height: 568 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${baseUrl}/dev-fixtures/location-place-authoring`)
  await expect(page.getByRole('heading', { name: 'Location authoring', exact: true })).toBeVisible()
  const selectors = page.getByRole('combobox', { name: 'Primary place (optional)' })
  await expect(selectors.first()).toHaveValue('')
  await selectors.first().focus()
  await expect(selectors.first()).toBeFocused()
  await selectors.first().selectOption('fixture-place')
  await expect(selectors.first()).toHaveValue('fixture-place')
  await page.getByText('Edit draft', { exact: true }).click()
  await expect(selectors.nth(1)).toHaveValue('unavailable-fixture-place')
  await selectors.nth(1).selectOption('')
  await expect(selectors.nth(1)).toHaveValue('')
  await expect(page.getByText('Linked place unavailable; guest photos are withheld.')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath(`location-place-${page.viewportSize()?.width}.png`),
    fullPage: true,
  })
  await selectors
    .nth(1)
    .locator('..')
    .screenshot({ path: testInfo.outputPath(`place-selector-${page.viewportSize()?.width}.png`) })
  if (testInfo.project.name === 'desktop-1440x900') {
    await page.setViewportSize({ width: 1024, height: 768 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await selectors
      .nth(1)
      .locator('..')
      .screenshot({ path: testInfo.outputPath('place-selector-1024.png') })
  }
})
