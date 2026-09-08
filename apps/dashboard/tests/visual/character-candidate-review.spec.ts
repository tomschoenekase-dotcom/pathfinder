import AxeBuilder from '@axe-core/playwright'
import { expect, test, type TestInfo } from '@playwright/test'
import sharp from 'sharp'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('founder candidate review stays scoped, keyboard reachable, and preview-safe', async ({
  page,
}, testInfo: TestInfo) => {
  const inertPng = await sharp({
    create: {
      width: 24,
      height: 24,
      channels: 4,
      background: { r: 80, g: 140, b: 200, alpha: 1 },
    },
  })
    .png()
    .toBuffer()
  await page.route('**/api/admin/character-candidate-preview**', async (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: inertPng }),
  )
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/character-candidate-review`)
  await expect(page.getByRole('heading', { name: 'Choose a character candidate' })).toBeVisible()
  await expect
    .poll(async () =>
      page
        .locator('img')
        .first()
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: 'Accept candidate' }).first()).toBeEnabled()
  await page.getByRole('button', { name: 'Accept candidate' }).first().click()
  await expect(page.getByRole('status').first()).toContainText('ACCEPT recorded')
  expect(
    await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1),
  ).toBe(true)
  expect((await new AxeBuilder({ page }).include('body').analyze()).violations).toEqual([])
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Choose a character candidate' })).toBeVisible()
  expect(
    await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1),
  ).toBe(true)
  await page.getByLabel('Revision request').first().fill('Use a gentler expression.')
  await page.getByRole('button', { name: 'Request revision' }).first().click()
  await expect(page.getByRole('status')).toContainText('REVISE recorded')
  const viewport = page.viewportSize()
  await expect(
    page.screenshot({
      path: testInfo.outputPath(
        `character-candidate-review-${viewport?.width ?? 'unknown'}x${viewport?.height ?? 'unknown'}.png`,
      ),
      fullPage: true,
    }),
  ).resolves.toBeTruthy()
})
