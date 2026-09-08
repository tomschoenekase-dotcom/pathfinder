import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const viewports = [
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'tablet-820', width: 820, height: 1180 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const

test('puts urgent founder questions first and keeps due labels readable at each viewport', async ({
  page,
}, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/dev-fixtures/founder-question-priority')
    await expect(page.getByRole('heading', { name: 'Priority questions' })).toBeVisible()
    const summaries = page.locator('details.group > summary')
    await expect(summaries).toHaveCount(4)
    await expect(summaries.first()).toContainText('Urgent: confirm whether the east arrival route')
    await expect(page.getByText('Due now', { exact: true })).toBeVisible()
    await expect(page.getByText('Overdue', { exact: true })).toBeVisible()
    await expect(page.getByText('Due in 1h', { exact: true })).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
    expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([])
    await page.screenshot({
      path: testInfo.outputPath(`founder-question-priority-${viewport.name}.png`),
      fullPage: true,
    })
  }
})
