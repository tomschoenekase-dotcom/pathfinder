import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('explicitly freezes and merges whole media identity groups', async ({ page }, testInfo) => {
  await page.goto('/dev-fixtures/media-identity-review')
  await expect(page.getByRole('heading', { name: 'Identity review', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start identity review' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Preview candidates' }).click()
  await expect(page.getByText('3 source mentions ready to freeze.')).toBeVisible()
  await page.getByRole('button', { name: 'Start identity review' }).click()
  await expect(page.getByText('Revision 1')).toBeVisible()
  await expect(
    page.getByText('No active merges. Every mention is currently distinct.'),
  ).toBeVisible()

  const groups = page.getByRole('checkbox')
  await groups.nth(0).check()
  await groups.nth(1).check()
  await page.getByLabel('Representative mention').selectOption('mention-b')
  await page
    .getByLabel('Why these mentions are the same entity')
    .fill('The same doorway and greenhouse marker appear in both retained sources.')
  await page.getByRole('button', { name: 'Merge selected groups' }).click()
  await expect(page.getByText('Revision 2')).toBeVisible()
  await expect(page.getByText('2 mentions merged')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Revert this merge' })).toBeVisible()

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  const screenshot = await page.screenshot({
    path: testInfo.outputPath('media-identity-review.png'),
    fullPage: true,
  })
  expect(screenshot.byteLength).toBeGreaterThan(4_000)
})
