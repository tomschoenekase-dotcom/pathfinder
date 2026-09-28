import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('rolling and interrupted captions stay readable in the mobile conversation', async ({
  page,
}, testInfo) => {
  test.skip(
    !['android-320-chromium', 'android-390-chromium'].includes(testInfo.project.name),
    'This fixture targets the two phone widths in the visitor acceptance matrix.',
  )
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })

  for (const voice of ['speaking', 'interrupted'] as const) {
    await page.goto(
      `/dev-fixtures/visitor-chat?mode=classic&state=speaking&conversation=empty&motion=reduced&voice=${voice}&network=online&language=English`,
      { waitUntil: 'domcontentloaded' },
    )
    await page
      .locator('nextjs-portal')
      .evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

    const fixture = page.locator('[data-fixture="visitor-chat"]')
    const conversation = page.getByRole('log', { name: 'Conversation' })
    const caption = page.getByRole('status', { name: 'Live voice caption' })
    const provisionalLabel =
      voice === 'interrupted' ? 'Guide · Interrupted; finalizing' : 'Guide · Caption in progress'
    await expect(fixture).toHaveAttribute('data-fixture-voice', voice)
    await expect(conversation).toContainText('The quieter route continues past the family lounge')
    await expect(caption).toContainText(provisionalLabel)
    await expect(caption).toHaveAttribute('aria-live', 'polite')
    await expect(page.getByRole('region', { name: 'Voice controls' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'End voice conversation' })).toHaveCount(1)
    if (voice === 'interrupted') {
      await expect(conversation).toContainText(
        'Take the east corridor past the family lounge, then use the accessible lift.',
      )
      await expect(conversation).toContainText('Interrupted; may be incomplete')
    }

    const captionText = caption.locator('p').nth(1)
    const transcriptMetrics = await captionText.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }))
    expect(transcriptMetrics.scrollHeight).toBeGreaterThan(transcriptMetrics.clientHeight)
    await captionText.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    expect(
      await captionText.evaluate((element) => element.scrollTop + element.clientHeight),
      JSON.stringify(transcriptMetrics),
    ).toBeGreaterThanOrEqual(transcriptMetrics.scrollHeight - 1)
    await captionText.focus()
    await expect(captionText).toBeFocused()
    const captionBounds = await caption.boundingBox()
    const conversationBounds = await conversation.boundingBox()
    expect(captionBounds).not.toBeNull()
    expect(conversationBounds).not.toBeNull()
    expect(captionBounds!.x).toBeGreaterThanOrEqual(conversationBounds!.x - 1)
    expect(captionBounds!.x + captionBounds!.width).toBeLessThanOrEqual(
      conversationBounds!.x + conversationBounds!.width + 1,
    )
    expect(captionBounds!.y + captionBounds!.height).toBeLessThanOrEqual(
      conversationBounds!.y + conversationBounds!.height + 1,
    )
    await captionText.evaluate((element) => {
      element.scrollTop = 0
    })

    const dimensions = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }))
    expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1)
    expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(
      dimensions.viewport + 1,
    )
    const voiceButton = page.getByRole('button', { name: 'End voice conversation' })
    const buttonBounds = await voiceButton.boundingBox()
    expect(buttonBounds).not.toBeNull()
    expect(buttonBounds!.height).toBeGreaterThanOrEqual(44)
    expect((await new AxeBuilder({ page }).include('body').analyze()).violations).toEqual([])

    await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      path: testInfo.outputPath(`visitor-voice-${voice}-${page.viewportSize()!.width}.png`),
    })
  }
})
