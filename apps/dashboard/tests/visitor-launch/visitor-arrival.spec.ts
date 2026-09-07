import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

async function hideFrameworkDevChrome(page: Page) {
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
}

async function expectViewportIntegrity(page: Page) {
  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }))
  expect(dimensions.bodyWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewportWidth + 1,
  )
  expect(dimensions.documentWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewportWidth + 1,
  )
}

async function expectAccessiblePage(page: Page) {
  const result = await new AxeBuilder({ page }).include('body').analyze()
  expect(result.violations.map(({ id }) => id)).toEqual([])
}

async function saveEvidence(page: Page, testInfo: TestInfo, name: string) {
  const screenshot = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath(`${name}.png`),
  })
  expect(screenshot.byteLength).toBeGreaterThan(2_000)
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
})

test('empty QR arrival keeps the guide CTA and prompt entry URLs intact', async ({
  page,
}, testInfo) => {
  await page.goto('/dev-fixtures/venue-arrival?state=empty&theme=forest&accent=%23245A4A')
  await hideFrameworkDevChrome(page)

  await expect(page.getByRole('heading', { name: 'Great Lakes Discovery Museum' })).toBeVisible()
  const cta = page.getByRole('link', { name: /Open your guide/u })
  await expect(cta).toHaveAttribute('href', '/great-lakes-museum/chat')
  await expect(page.getByRole('link', { name: /What should I see first\?/u })).toHaveAttribute(
    'href',
    /\/great-lakes-museum\/chat\?prompt=What%20should%20I%20see%20first%3F/u,
  )
  await expect(page.getByRole('img')).toHaveCount(0)

  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'arrival-empty-forest')
})

test('media outage preserves entry actions and scoped dark palette at a narrow viewport', async ({
  page,
}, testInfo) => {
  await page.goto('/dev-fixtures/venue-arrival?state=unavailable&theme=dark&accent=%23ABCDEF')
  await hideFrameworkDevChrome(page)

  await expect(
    page.getByText('Venue photos are temporarily unavailable. Your guide is ready.'),
  ).toBeVisible()
  const cta = page.getByRole('link', { name: /Open your guide/u })
  await expect(cta).toBeVisible()
  const palette = await page.locator('main').evaluate((element) => ({
    accent: getComputedStyle(element).getPropertyValue('--arrival-accent').trim(),
    text: getComputedStyle(element).getPropertyValue('--arrival-text').trim(),
  }))
  expect(palette.accent).toMatch(/^#[0-9a-f]{6}$/iu)
  expect(palette.accent.toLowerCase()).not.toBe('#3a7bd5')
  expect(palette.text).toBeTruthy()
  const bounds = await cta.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.width).toBeGreaterThanOrEqual(44)
  expect(bounds!.height).toBeGreaterThanOrEqual(44)

  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'arrival-unavailable-dark')
})

for (const viewport of [
  { width: 320, height: 360 },
  { width: 390, height: 360 },
] as const) {
  test(`short mobile chat remains usable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.goto(
      '/dev-fixtures/visitor-chat?mode=character&state=listening&conversation=long&motion=reduced&network=offline&theme=forest&accent=%23245A4A',
    )
    await hideFrameworkDevChrome(page)

    const log = page.getByRole('log')
    await expect(log).toBeVisible()
    const logBounds = await log.boundingBox()
    expect(logBounds).not.toBeNull()
    expect(logBounds!.height).toBeGreaterThanOrEqual(80)
    const composer = page.getByRole('textbox')
    await composer.scrollIntoViewIfNeeded()
    await composer.fill('First line of a short visit note.\nSecond line remains readable.')
    await composer.focus()
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue(
      'First line of a short visit note.\nSecond line remains readable.',
    )
    expect((await log.boundingBox())!.height).toBeGreaterThanOrEqual(80)
    const bounds = await composer.boundingBox()
    const viewportSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(bounds).not.toBeNull()
    expect(bounds!.width).toBeLessThanOrEqual(viewportSize.width)
    expect(bounds!.height).toBeGreaterThanOrEqual(44)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewportSize.height + 1)

    await expectViewportIntegrity(page)
    const footer = page.locator('footer').last()
    const footerBounds = await footer.boundingBox()
    expect(footerBounds).not.toBeNull()
    expect(footerBounds!.y).toBeLessThanOrEqual(viewportSize.height + 1)
    await expectAccessiblePage(page)
    await saveEvidence(page, testInfo, `chat-short-${viewport.width}`)
  })
}

test('a failed turn stays readable without collapsing short-phone conversation space', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 360 })
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=error&conversation=long&motion=reduced&theme=forest&accent=%23245A4A',
  )
  await hideFrameworkDevChrome(page)

  const log = page.getByRole('log')
  const alert = log.getByRole('alert')
  const composer = page.getByRole('textbox')
  await expect(alert).toContainText('The test response could not be loaded.')
  await expect(composer).toBeVisible()

  const logBounds = await log.boundingBox()
  const composerBounds = await composer.boundingBox()
  expect(logBounds).not.toBeNull()
  expect(composerBounds).not.toBeNull()
  expect(logBounds!.height).toBeGreaterThanOrEqual(80)
  expect(composerBounds!.y + composerBounds!.height).toBeLessThanOrEqual(361)

  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'chat-error-short-320')
})

test('chat theme and accent stay scoped to chat variables', async ({ page }) => {
  for (const [theme, accent] of [
    ['forest', '#245A4A'],
    ['dark', '#ABCDEF'],
  ] as const) {
    await page.goto(
      `/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=empty&motion=reduced&theme=${theme}&accent=${encodeURIComponent(accent)}`,
    )
    await hideFrameworkDevChrome(page)
    const vars = await page.locator('[data-fixture="visitor-chat"] main').evaluate((element) => {
      const styles = getComputedStyle(element)
      return {
        chatAccent: styles.getPropertyValue('--chat-accent').trim(),
        arrivalAccent: styles.getPropertyValue('--arrival-accent').trim(),
      }
    })
    expect(vars.chatAccent).toMatch(/^#[0-9a-f]{6}$/iu)
    expect(vars.arrivalAccent).toBe('')
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--chat-accent'),
      ),
    ).toBe('')
    await expectAccessiblePage(page)
  }
})
