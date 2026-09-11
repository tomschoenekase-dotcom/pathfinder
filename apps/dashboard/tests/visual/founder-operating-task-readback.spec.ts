import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

async function inspect(page: Page, testInfo: TestInfo, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/founder-operating-conversation`)
  await expect(
    page.getByText(/Initial response · Recorded for triage · not executed/i),
  ).toBeVisible()
  await expect(page.getByText('Current task status')).toBeVisible()
  await expect(page.getByText('running')).toBeVisible()
  const runLink = page.getByRole('link', { name: 'Open real agent run' })
  await runLink.focus()
  await expect(runLink).toBeFocused()
  await expect
    .poll(() => page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1))
    .toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  const path = testInfo.outputPath(`founder-task-readback-${width}x${height}.png`)
  await page.screenshot({ path, fullPage: true, animations: 'disabled', caret: 'hide' })
  await testInfo.attach(`founder task readback ${width}px`, { path, contentType: 'image/png' })
}

test('real directive task status remains distinct from the initial exchange', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await inspect(page, testInfo, 320, 720)
  await inspect(page, testInfo, 1440, 900)
})
