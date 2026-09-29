import { expect, test } from '@playwright/test'

test('a partner app round-trips between its screens and the live guide', async ({
  page,
}, testInfo) => {
  await page.goto('/dev-fixtures/app-host')
  await expect(page.locator('[data-simulator="app-host"]')).toHaveAttribute(
    'data-guide-ready',
    'true',
    { timeout: 60_000 },
  )
  await page.screenshot({ path: testInfo.outputPath('1-pass-home.png') })

  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  const guide = page.frameLocator('iframe[title="Torchiko guide"]')
  const handBack = guide.getByRole('button', { name: 'See in app: Harbor Aquarium' })
  await expect(handBack).toBeVisible()
  await handBack.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('2-guide-in-app.png') })

  await handBack.click()
  await expect(page.getByRole('heading', { name: 'Harbor Aquarium' })).toBeVisible()
  await expect(page.getByText('fixture-pass-aquarium')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('3-native-attraction.png') })

  await page.getByRole('button', { name: 'Ask the guide about this' }).click()
  await expect(guide.locator('textarea')).toHaveValue(
    'What should we know before visiting Harbor Aquarium?',
  )
  // The earlier conversation is still there: the guide was never reloaded.
  await expect(
    guide.getByText('Start at the Harbor Aquarium when it opens', { exact: false }),
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('4-ask-about-this.png') })
  expect(await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth)).toBe(true)
})
