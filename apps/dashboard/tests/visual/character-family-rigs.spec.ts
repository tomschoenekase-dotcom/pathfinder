import AxeBuilder from '@axe-core/playwright'
import { expect, test, type TestInfo } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('real family renderer articulates layers, reduces motion, and recovers from asset failure', async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/character-family-rigs?state=speaking`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

  const owl = page.getByRole('img', { name: 'Neutral owl: speaking' })
  await expect(owl).toHaveAttribute('data-rig-family', 'compact-creature-v1')
  await expect(owl.locator('[data-rig-layer="wing"]')).toBeVisible()
  await expect(
    page
      .getByRole('img', { name: 'Neutral astronaut: speaking' })
      .locator('[data-rig-layer="head"]'),
  ).toBeVisible()
  await expect(
    page.getByRole('img', { name: 'Neutral morph: speaking' }).locator('[data-rig-layer="face"]'),
  ).toBeVisible()

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(
    `${dashboardBaseUrl}/dev-fixtures/character-family-rigs?state=thinking&motion=reduced`,
  )
  await expect(page.getByRole('img', { name: 'Neutral owl: thinking' })).toHaveAttribute(
    'data-rig-motion',
    'reduced',
  )

  await page.goto(
    `${dashboardBaseUrl}/dev-fixtures/character-family-rigs?state=error&failure=double`,
  )
  await expect(page.getByRole('img', { name: 'Neutral owl: error' }).getByText('T')).toBeVisible()

  await page.goto(`${dashboardBaseUrl}/dev-fixtures/character-family-rigs?state=speaking`)
  await expect(
    page.getByRole('img', { name: 'Neutral owl: speaking' }).locator('[data-rig-layer="wing"]'),
  ).toBeVisible()
  await expect(page.getByRole('img', { name: 'Neutral owl: speaking' }).getByText('T')).toHaveCount(
    0,
  )

  expect((await new AxeBuilder({ page }).include('body').analyze()).violations).toEqual([])
  expect(
    await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1),
  ).toBe(true)
  const screenshot = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath('character-family-rigs.png'),
    fullPage: true,
  })
  expect(screenshot.byteLength).toBeGreaterThan(10_000)
})
