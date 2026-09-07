import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('durable voice segments read back inside ordinary mobile chat history', async ({
  page,
}, testInfo) => {
  test.skip(
    !['android-320-chromium', 'android-390-chromium'].includes(testInfo.project.name),
    'This projection proof targets the two phone widths in the visitor acceptance matrix.',
  )
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=voice-history&motion=reduced&voice=none&network=online&language=English',
  )
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

  const log = page.getByRole('log', { name: 'Conversation' })
  await expect(log.getByText('I can help you find a quieter route.')).toBeVisible()
  await expect(log.getByText('Can we avoid the busy central stairs?')).toBeVisible()
  await expect(
    log.getByText('Take the east corridor past the family lounge, then use the accessible lift.'),
  ).toBeVisible()
  await expect(log.getByText(/Voice transcript · Captured/u)).toBeVisible()
  await expect(log.getByText(/Voice transcript · Interrupted; may be incomplete/u)).toBeVisible()
  await expect(page.getByRole('button', { name: /voice conversation/u })).toHaveCount(0)

  const horizontalBounds = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }))
  expect(horizontalBounds.body, JSON.stringify(horizontalBounds)).toBeLessThanOrEqual(
    horizontalBounds.viewport + 1,
  )
  expect(horizontalBounds.document, JSON.stringify(horizontalBounds)).toBeLessThanOrEqual(
    horizontalBounds.viewport + 1,
  )
  expect((await new AxeBuilder({ page }).include('body').analyze()).violations).toEqual([])

  await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath(`visitor-voice-history-${page.viewportSize()!.width}.png`),
  })
})
