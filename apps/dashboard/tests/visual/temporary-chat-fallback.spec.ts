import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const visitorBaseUrl = process.env.PLAYWRIGHT_VISITOR_BASE_URL ?? 'http://127.0.0.1:3000'

test('temporary chat fallback omits unsupported actions', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`${visitorBaseUrl}/dev-fixtures/temporary-chat-fallback`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

  const fixture = page.getByTestId('temporary-chat-fallback-fixture')
  await expect(fixture).toBeVisible()
  await expect(
    page.getByText("I'm having trouble right now. Please try again in a moment."),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tell me more' })).toHaveCount(0)
  await expect(page.getByLabel('Rate this answer')).toHaveCount(0)
  await expect(page.getByLabel('Helpful')).toHaveCount(0)
  await expect(page.getByLabel('Not helpful')).toHaveCount(0)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true)
  expect(
    (
      await new AxeBuilder({ page })
        .include('[data-testid="temporary-chat-fallback-fixture"]')
        .analyze()
    ).violations,
  ).toEqual([])

  await fixture.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath(`temporary-chat-fallback-${testInfo.project.name}.png`),
  })
})
