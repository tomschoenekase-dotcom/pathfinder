import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

async function inspect(page: Page, testInfo: TestInfo, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/prospect-correspondence`)
  await page.getByText('Historical invitation draft · DRAFT').click()
  await expect(page.getByText('Draft only · nothing was sent.')).toBeVisible()
  await expect(page.getByText(/not send eligible/)).toBeVisible()
  await expect(page.getByRole('button', { name: /send/i })).toHaveCount(0)
  await expect
    .poll(() => page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1))
    .toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  const path = testInfo.outputPath(`prospect-invitation-draft-${width}x${height}.png`)
  await page.screenshot({ path, fullPage: true, animations: 'disabled', caret: 'hide' })
  await testInfo.attach(`prospect invitation draft ${width}px`, {
    path,
    contentType: 'image/png',
  })
}

test('historical invitation draft is bounded and explicit at mobile and desktop widths', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await inspect(page, testInfo, 320, 720)
  await inspect(page, testInfo, 1440, 900)
})
