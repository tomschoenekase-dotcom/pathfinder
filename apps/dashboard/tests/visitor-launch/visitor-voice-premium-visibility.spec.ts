import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

async function installLocalAvailabilitySeams(page: Page, isEnabled: () => boolean) {
  await page.addInitScript(() => {
    let getUserMediaCalls = 0
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          getUserMediaCalls += 1
          throw new Error('Voice start is outside this fixture proof.')
        },
      },
    })
    Object.assign(window, {
      RTCPeerConnection: class LocalPeerConnection {},
      __voiceFixtureGetUserMediaCalls: () => getUserMediaCalls,
    })
  })

  const proceduresCalled: string[] = []
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      await route.abort('blockedbyclient')
      return
    }
    if (!url.pathname.startsWith('/api/trpc/')) {
      await route.continue()
      return
    }

    const procedures = decodeURIComponent(url.pathname.split('/api/trpc/')[1] ?? '').split(',')
    proceduresCalled.push(...procedures)
    const envelopes = procedures.map((procedure) => ({
      result: {
        data: {
          json:
            procedure === 'voice.availability'
              ? { enabled: isEnabled(), premiumAvailable: isEnabled() }
              : null,
        },
      },
    }))
    const body = JSON.stringify(url.searchParams.get('batch') === '1' ? envelopes : envelopes[0])
    await route.fulfill({
      contentType: 'application/json',
      body,
    })
  })
  return proceduresCalled
}

test('premium voice visibility stays compact in the composer across mobile and desktop', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'android-390-chromium',
    'This proof sets both required viewport widths in one synthetic fixture run.',
  )

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })

    for (const entitlement of ['entitled', 'non-entitled'] as const) {
      const voice = entitlement === 'entitled' ? 'idle' : 'none'
      await page.goto(
        `/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=empty&motion=reduced&voice=${voice}&network=online&language=English`,
      )
      await page
        .locator('nextjs-portal')
        .evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

      const fixture = page.locator('[data-fixture="visitor-chat"]')
      await expect(fixture).toHaveAttribute('data-fixture-voice', voice)
      const composerField = page.getByRole('textbox').locator('xpath=..')
      const mic = page.getByRole('button', { name: 'Start voice conversation' })

      if (entitlement === 'entitled') {
        await expect(mic).toBeVisible()
        await expect(
          composerField.getByRole('button', { name: 'Start voice conversation' }),
        ).toHaveCount(1)
        await expect(fixture.locator('[data-voice-control-header]')).toHaveCount(0)
        const micBounds = await mic.boundingBox()
        expect(micBounds).not.toBeNull()
        expect(micBounds!.height).toBeGreaterThanOrEqual(44)
        expect(micBounds!.width).toBeGreaterThanOrEqual(44)
      } else {
        await expect(page.getByRole('button', { name: /voice conversation/i })).toHaveCount(0)
      }

      const dimensions = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        document: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }))
      expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(
        dimensions.viewport + 1,
      )
      expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(
        dimensions.viewport + 1,
      )
      expect((await new AxeBuilder({ page }).include('body').analyze()).violations).toEqual([])

      await page.screenshot({
        animations: 'disabled',
        caret: 'hide',
        path: testInfo.outputPath(`visitor-voice-${entitlement}-${width}.png`),
      })
    }
  }
})

test('real voice availability controls composer mic and Settings eligibility', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'android-390-chromium',
    'This proof sets both required viewport widths in one synthetic fixture run.',
  )

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  let voiceEnabled = true
  const proceduresCalled = await installLocalAvailabilitySeams(page, () => voiceEnabled)

  for (const width of [390, 1280]) {
    voiceEnabled = true
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto(
      '/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=empty&motion=reduced&voice=server&network=online&language=English',
    )
    await page
      .locator('nextjs-portal')
      .evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

    await expect(page.locator('[data-fixture="visitor-chat"]')).toHaveAttribute(
      'data-fixture-voice',
      'server',
    )
    await expect.poll(() => proceduresCalled).toContain('voice.availability')
    const mic = page.getByRole('button', { name: 'Start voice conversation' })
    await expect(mic).toBeVisible()
    const composerField = page.getByRole('textbox').locator('xpath=..')
    await expect(
      composerField.getByRole('button', { name: 'Start voice conversation' }),
    ).toHaveCount(1)

    await page.getByRole('button', { name: 'Settings' }).click()
    const voiceSwitch = page.getByRole('switch', { name: 'Voice conversation' })
    await expect(voiceSwitch).toBeVisible()
    await expect(voiceSwitch).toBeChecked()
    await voiceSwitch.uncheck()
    await expect(page.getByRole('button', { name: /voice conversation/i })).toHaveCount(0)
    await voiceSwitch.check()
    await expect(mic).toBeVisible()
    await expect(voiceSwitch).toBeChecked()
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    voiceEnabled = false
    await page.goto(
      '/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=empty&motion=reduced&voice=server&network=online&language=English',
    )
    await page
      .locator('nextjs-portal')
      .evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
    await expect(page.getByRole('button', { name: /voice conversation/i })).toHaveCount(0)
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByRole('switch', { name: 'Voice conversation' })).toHaveCount(0)
  }

  expect(proceduresCalled).toContain('voice.availability')
  expect(proceduresCalled).not.toContain('voice.start')
  expect(proceduresCalled).not.toContain('voice.connected')
  expect(proceduresCalled).not.toContain('voice.groundingContext')
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __voiceFixtureGetUserMediaCalls: () => number }
      ).__voiceFixtureGetUserMediaCalls(),
    ),
  ).toBe(0)
  const dimensions = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }))
  expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1)
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewport + 1,
  )
  expect((await new AxeBuilder({ page }).include('body').analyze()).violations).toEqual([])
  await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath('visitor-voice-disabled-settings-1280.png'),
  })
})
