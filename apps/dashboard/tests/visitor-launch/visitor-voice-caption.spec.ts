import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('rolling and interrupted captions remain readable at the bottom of the mobile transcript', async ({
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
    )
    await page
      .locator('nextjs-portal')
      .evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

    const fixture = page.locator('[data-fixture="visitor-chat"]')
    const transcript = page.getByLabel('Voice transcript')
    const provisionalLabel =
      voice === 'interrupted' ? '(interrupted; finalizing)' : '(caption in progress)'
    await expect(fixture).toHaveAttribute('data-fixture-voice', voice)
    await expect(transcript).toContainText('The quieter route continues past the family lounge')
    await expect(transcript).toContainText(provisionalLabel)

    const transcriptMetrics = await transcript.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }))
    expect(transcriptMetrics.scrollHeight).toBeGreaterThan(transcriptMetrics.clientHeight)
    expect(
      transcriptMetrics.scrollTop + transcriptMetrics.clientHeight,
      JSON.stringify(transcriptMetrics),
    ).toBeGreaterThanOrEqual(transcriptMetrics.scrollHeight - 1)
    await transcript.focus()
    await expect(transcript).toBeFocused()

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
