import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  return errors
}

async function hideFrameworkDevChrome(page: Page) {
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
}

async function expectViewportIntegrity(page: Page) {
  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    scrollY: window.scrollY,
  }))
  expect(dimensions.bodyWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewportWidth + 1,
  )
  expect(dimensions.documentWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewportWidth + 1,
  )
  expect(dimensions.scrollY, JSON.stringify(dimensions)).toBe(0)
}

async function expectComposerReachable(page: Page) {
  const composer = page.getByRole('textbox')
  await composer.scrollIntoViewIfNeeded()
  if (await composer.isEnabled()) {
    await composer.focus()
    await expect(composer).toBeFocused()
  } else {
    await expect(composer).toBeDisabled()
  }
  const bounds = await composer.boundingBox()
  const viewportHeight = await page.evaluate(() => window.innerHeight)
  expect(bounds).not.toBeNull()
  expect(bounds!.height).toBeGreaterThanOrEqual(44)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewportHeight + 1)
}

async function expectAccessiblePage(page: Page) {
  const result = await new AxeBuilder({ page }).include('body').analyze()
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([])
}

async function expectTouchTargets(page: Page) {
  const undersized = await page
    .locator('button:visible, a[href]:visible, select:visible, textarea:visible')
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            label:
              element.getAttribute('aria-label') ??
              element.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 80) ??
              element.tagName,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        })
        .filter(({ width, height }) => width < 44 || height < 44),
    )
  expect(undersized).toEqual([])
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

test('keyboard-sized viewport gives footer space back to the conversation', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=long&motion=reduced&network=online&language=English',
  )
  await hideFrameworkDevChrome(page)

  const shell = page.locator('[data-fixture="visitor-chat"] > div')
  const footer = page.locator('footer')
  const conversation = page.getByRole('log')
  const composer = page.getByRole('textbox')
  await expect(footer).toBeVisible()
  await composer.focus()

  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', {
      configurable: true,
      value: 320,
    })
    window.visualViewport!.dispatchEvent(new Event('resize'))
  })

  await expect(shell).toHaveAttribute('data-keyboard-open', 'true')
  await expect(shell).toHaveCSS('height', '320px')
  await expect(footer).toBeHidden()
  await expectComposerReachable(page)
  const keyboardConversationHeight = (await conversation.boundingBox())!.height
  expect(keyboardConversationHeight).toBeGreaterThanOrEqual(80)
  const composerBounds = await composer.boundingBox()
  expect(composerBounds).not.toBeNull()
  expect(composerBounds!.y + composerBounds!.height).toBeLessThanOrEqual(320)
  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  const screenshot = await shell.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath('visitor-chat-keyboard-320.png'),
  })
  expect(screenshot.byteLength).toBeGreaterThan(2_000)
})

test('approved chat branding fails closed on a short mobile viewport', async ({
  page,
}, testInfo) => {
  let failImages = false
  const interceptedAssets: string[] = []
  await page.setViewportSize({
    width: Math.min(page.viewportSize()?.width ?? 390, 390),
    height: 420,
  })
  await page.route('**/dev-fixtures/visitor-brand-*.svg', async (route) => {
    interceptedAssets.push(route.request().url())
    if (failImages) return route.fulfill({ status: 404, body: '' })
    const banner = route.request().url().includes('visitor-brand-banner')
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: banner
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="240"><rect width="900" height="240" fill="#fff"/><path d="M0 170 Q220 70 450 170 T900 170 V240 H0Z" fill="#f8f4e8"/></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><circle cx="48" cy="48" r="44" fill="#f3d38a"/><path d="M28 56 Q48 72 68 56" fill="none" stroke="#245a4a" stroke-width="6"/></svg>',
    })
  })
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=empty&motion=reduced&branding=approved&theme=forest',
  )
  await hideFrameworkDevChrome(page)

  const header = page.locator('header')
  await expect(header).toHaveAttribute('data-branding-banner-state', 'ready')
  await expect(header.locator('img')).toHaveCount(2)
  await expect.poll(() => interceptedAssets.length).toBe(2)
  await expect(page.getByRole('heading', { name: 'Museum Guide' })).toHaveClass(/text-white/u)
  await expect(page.getByRole('button', { name: 'New conversation' })).toHaveClass(/text-white/u)
  await expectViewportIntegrity(page)
  await expectComposerReachable(page)
  await expectTouchTargets(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'visitor-chat-approved-branding-short-mobile')

  failImages = true
  interceptedAssets.length = 0
  await page.reload()
  await hideFrameworkDevChrome(page)
  await expect(header).toHaveAttribute('data-branding-banner-state', 'failed')
  await expect(header.locator('img')).toHaveCount(0)
  await expect.poll(() => interceptedAssets.length).toBe(2)
  await expect(page.getByRole('heading', { name: 'Museum Guide' })).toHaveClass(
    /text-\[var\(--chat-text\)\]/u,
  )
  await expectViewportIntegrity(page)
  await expectComposerReachable(page)
  await expectTouchTargets(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'visitor-chat-failed-branding-short-mobile')
})

test('long RTL and CJK conversation remains usable while offline', async ({ page }, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=listening&conversation=multilingual&motion=reduced&network=offline&language=العربية',
  )
  await hideFrameworkDevChrome(page)

  const fixture = page.locator('[data-fixture="visitor-chat"]')
  await expect(fixture.locator(':scope > [dir="rtl"]')).toBeVisible()
  await expect(page.getByText(/هل يمكنك اقتراح/)).toBeVisible()
  await expect(page.getByText(/子どもと一緒に/)).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /غير متصل/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /الاتصال/ })).toBeDisabled()

  await expectViewportIntegrity(page)
  await expectComposerReachable(page)
  await expectTouchTargets(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'visitor-offline-multilingual')
  expect(runtimeErrors).toEqual([])
})

test('delayed response remains bounded and motion-safe', async ({ page }, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=thinking&conversation=long&motion=reduced&network=online&language=English',
  )
  await hideFrameworkDevChrome(page)

  await expect(page.locator('[data-fixture-state="thinking"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sending message' })).toBeDisabled()
  const activeAnimations = await page.locator('[class*="animate-"]').evaluateAll((elements) =>
    elements
      .map((element) => ({
        className: element.getAttribute('class'),
        animationName: window.getComputedStyle(element).animationName,
      }))
      .filter(({ animationName }) => animationName !== 'none'),
  )
  expect(activeAnimations).toEqual([])

  await expectViewportIntegrity(page)
  await expectComposerReachable(page)
  await expectTouchTargets(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'visitor-delayed-response')
  expect(runtimeErrors).toEqual([])
})

test('streaming response remains readable, quiet to assistive tech, and composer-safe', async ({
  page,
}, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=speaking&conversation=streaming&motion=reduced&network=online&language=English',
  )
  await hideFrameworkDevChrome(page)

  await expect(page.locator('[data-fixture-state="speaking"]')).toBeVisible()
  await expect(page.getByText(/lake ecology gallery is on the upper floor/)).toBeVisible()
  const liveStatus = page.getByRole('status').filter({ hasText: 'Museum Guide is responding' })
  await expect(liveStatus).toHaveText('Museum Guide is responding')
  await expect(liveStatus).toHaveClass(/sr-only/u)
  await expect(page.getByRole('button', { name: 'Sending message' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Tell me more' })).toHaveCount(0)

  await expectViewportIntegrity(page)
  await expectComposerReachable(page)
  await expectTouchTargets(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'visitor-streaming-response')
  expect(runtimeErrors).toEqual([])
})

test('localized loading surface remains launch-safe', async ({ page }, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto('/dev-fixtures/visitor-chat?surface=loading&language=العربية')
  await hideFrameworkDevChrome(page)
  await expect(page.getByRole('status')).toHaveAttribute('dir', 'rtl')
  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'visitor-loading-arabic')
  expect(runtimeErrors).toEqual([])
})

test('localized error recovery remains keyboard reachable', async ({ page }, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto('/dev-fixtures/visitor-chat?surface=error&language=日本語')
  await hideFrameworkDevChrome(page)
  await expect(
    page.getByRole('alert').filter({ hasText: 'This venue link is not active.' }),
  ).toBeVisible()
  const retry = page.getByRole('button')
  await expect(retry).toHaveCount(1)
  await retry.focus()
  await expect(retry).toBeFocused()
  await expectViewportIntegrity(page)
  await expectTouchTargets(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'visitor-error-japanese')
  expect(runtimeErrors).toEqual([])
})
