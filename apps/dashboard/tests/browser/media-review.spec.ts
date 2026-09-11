import { expect, test } from '@playwright/test'

test('retains the actual video method during source review on each viewport', async ({ page }) => {
  await page.goto('/dev-fixtures/media-review')
  await expect(page.getByText('Google video analysis · 1 frame per second')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'north-hall.mp4' })).toBeVisible()
  await page.getByText('Original AI finding', { exact: true }).click()
  await expect(
    page.getByRole('listitem').filter({ hasText: 'The entrance beyond the sign was not visible.' }),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.screenshot({ path: test.info().outputPath('media-review.png'), fullPage: true })
})
