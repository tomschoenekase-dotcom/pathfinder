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

  // Emulate iOS: the keyboard shrinks the visual viewport and pans it 90px down the layout
  // viewport to reveal the focused field. The shell must follow that pan, header included.
  const setVisualViewport = (height: number, offsetTop: number) =>
    page.evaluate(
      ({ height, offsetTop }) => {
        Object.defineProperty(window.visualViewport!, 'height', {
          configurable: true,
          value: height,
        })
        Object.defineProperty(window.visualViewport!, 'offsetTop', {
          configurable: true,
          value: offsetTop,
        })
        window.visualViewport!.dispatchEvent(new Event('resize'))
      },
      { height, offsetTop },
    )
  await setVisualViewport(320, 90)

  await expect(shell).toHaveAttribute('data-keyboard-open', 'true')
  await expect(shell).toHaveCSS('height', '320px')
  await expect(shell).toHaveCSS('position', 'fixed')
  expect((await shell.boundingBox())!.y).toBe(90)
  const header = page.locator('header')
  const headerBox = (await header.boundingBox())!
  expect(headerBox.y).toBeGreaterThanOrEqual(90)
  const documentPinned = await page.evaluate(() => ({
    scrollY: window.scrollY,
    bodyPosition: getComputedStyle(document.body).position,
  }))
  expect(documentPinned).toEqual({ scrollY: 0, bodyPosition: 'fixed' })
  await expect(footer).toBeHidden()
  await expectComposerReachable(page)
  const keyboardConversationHeight = (await conversation.boundingBox())!.height
  expect(keyboardConversationHeight).toBeGreaterThanOrEqual(80)
  const composerBounds = await composer.boundingBox()
  expect(composerBounds).not.toBeNull()
  expect(composerBounds!.y + composerBounds!.height).toBeLessThanOrEqual(90 + 320)
  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  const screenshot = await shell.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath('visitor-chat-keyboard-320.png'),
  })
  expect(screenshot.byteLength).toBeGreaterThan(2_000)

  // Dismissing the keyboard returns the whole shell to the top of the screen at full height.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await setVisualViewport(568, 0)
  await expect(shell).not.toHaveAttribute('data-keyboard-open', 'true')
  await expect(footer).toBeVisible()
  const restored = (await shell.boundingBox())!
  expect(restored.y).toBe(0)
  expect(restored.height).toBe(568)
  await expectViewportIntegrity(page)
})

test('repeated keyboard open and dismiss cycles land on the same layout every time', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=long&motion=reduced&network=online&language=English',
  )
  await hideFrameworkDevChrome(page)
  const shell = page.locator('[data-fixture="visitor-chat"] > div')
  const composer = page.getByRole('textbox')
  const setVisualViewport = (height: number, offsetTop: number) =>
    page.evaluate(
      ({ height, offsetTop }) => {
        const define = (key: string, value: number) =>
          Object.defineProperty(window.visualViewport!, key, { configurable: true, value })
        define('height', height)
        define('offsetTop', offsetTop)
        window.visualViewport!.dispatchEvent(new Event('resize'))
      },
      { height, offsetTop },
    )
  const opened: Array<{ y: number; height: number; gap: number }> = []
  for (let cycle = 0; cycle < 4; cycle += 1) {
    await composer.focus()
    await setVisualViewport(340, 110)
    await expect(shell).toHaveAttribute('data-keyboard-open', 'true')
    const box = (await shell.boundingBox())!
    const composerBox = (await composer.boundingBox())!
    // The shell is exactly the visible area, and the composer sits just above the keyboard.
    opened.push({
      y: box.y,
      height: box.height,
      gap: Math.round(110 + 340 - (composerBox.y + composerBox.height)),
    })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await setVisualViewport(700, 0)
    await expect(shell).not.toHaveAttribute('data-keyboard-open', 'true')
    const restored = (await shell.boundingBox())!
    expect(restored.y).toBe(0)
    expect(restored.height).toBe(700)
  }
  expect(opened.every((entry) => entry.y === 110 && entry.height === 340)).toBe(true)
  // No cumulative drift, and no huge blank band between the composer and the keyboard.
  expect(new Set(opened.map((entry) => entry.gap)).size).toBe(1)
  expect(opened[0]!.gap).toBeLessThanOrEqual(24)
})

test('a valid send on a phone dismisses the keyboard and the composer returns to the bottom', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, 'touch-only phone behaviour')
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=long&motion=reduced&network=online&language=English',
  )
  await hideFrameworkDevChrome(page)
  const shell = page.locator('[data-fixture="visitor-chat"] > div')
  const composer = page.getByRole('textbox')
  const viewportHeight = page.viewportSize()!.height
  const setVisualViewport = (height: number, offsetTop: number) =>
    page.evaluate(
      ({ height, offsetTop }) => {
        const define = (key: string, value: number) =>
          Object.defineProperty(window.visualViewport!, key, { configurable: true, value })
        define('height', height)
        define('offsetTop', offsetTop)
        window.visualViewport!.dispatchEvent(new Event('resize'))
      },
      { height, offsetTop },
    )
  // Report the moment focus leaves the composer, relative to the submit keystroke.
  await page.evaluate(() => {
    const field = document.querySelector('[data-chat-shell] textarea')!
    delete (window as unknown as { __blurAt?: number }).__blurAt
    field.addEventListener('blur', () => {
      ;(window as unknown as { __blurAt?: number }).__blurAt = performance.now()
    })
  })
  await composer.tap()
  await setVisualViewport(Math.round(viewportHeight * 0.55), 120)
  await expect(shell).toHaveAttribute('data-keyboard-open', 'true')
  await composer.fill('Where are the restrooms?')
  const sentAt = await page.evaluate(() => performance.now())
  await composer.press('Enter')
  const blurAt = await page.evaluate(() => (window as unknown as { __blurAt?: number }).__blurAt)
  expect(blurAt, 'the submit itself dismisses the keyboard').toBeDefined()
  expect(blurAt! - sentAt).toBeLessThan(250)
  await expect(composer).not.toBeFocused()
  // The browser hides the keyboard; the shell returns to the full layout at the bottom.
  await setVisualViewport(viewportHeight, 0)
  await expect(shell).not.toHaveAttribute('data-keyboard-open', 'true')
  await expect(shell).not.toHaveAttribute('data-viewport-pinned', 'true')
  const restored = (await shell.boundingBox())!
  expect(restored.y).toBe(0)
  expect(Math.round(restored.height)).toBe(viewportHeight)
  const composerBox = (await composer.boundingBox())!
  expect(composerBox.y + composerBox.height).toBeGreaterThan(viewportHeight * 0.75)
  // Nothing refocuses it while or after the answer arrives.
  await page.waitForTimeout(1_500)
  await expect(composer).not.toBeFocused()
  await expectViewportIntegrity(page)
})

test('the empty composer hint is one clean line at narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=empty&motion=reduced&network=online&language=English',
  )
  await hideFrameworkDevChrome(page)
  const composer = page.getByRole('textbox')
  const hint = page
    .locator('[data-chat-shell] textarea')
    .locator('xpath=preceding-sibling::span[1]')
  await expect(hint).toBeVisible()
  const geometry = await hint.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      height: node.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      whiteSpace: style.whiteSpace,
    }
  })
  expect(geometry.whiteSpace).toBe('nowrap')
  expect(Math.round(geometry.height)).toBe(geometry.lineHeight)
  const hintBox = (await hint.boundingBox())!
  const fieldBox = (await composer.boundingBox())!
  expect(hintBox.y).toBeGreaterThanOrEqual(fieldBox.y)
  expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(fieldBox.y + fieldBox.height)
  await composer.fill('x')
  await expect(hint).toHaveCount(0)
})

test('keyboard detection survives innerHeight shrinking with the visual viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=long&motion=reduced&network=online&language=English&theme=dark',
  )
  await hideFrameworkDevChrome(page)
  await page.waitForSelector('html[data-visitor-chat]', { state: 'attached' })

  const shell = page.locator('[data-fixture="visitor-chat"] > div')
  const composer = page.getByRole('textbox')
  await expect(shell).not.toHaveAttribute('data-keyboard-open', 'true')
  await composer.focus()

  // Recent iOS Safari: the keyboard shrinks innerHeight and the visual viewport together, and
  // Safari pans the visual viewport (offsetTop) to reveal the field.
  await page.evaluate(() => {
    const define = (target: object, key: string, value: number) =>
      Object.defineProperty(target, key, { configurable: true, value })
    define(window, 'innerHeight', 380)
    define(window.visualViewport!, 'height', 380)
    define(window.visualViewport!, 'offsetTop', 60)
    window.dispatchEvent(new Event('resize'))
    window.visualViewport!.dispatchEvent(new Event('resize'))
  })

  await expect(shell).toHaveAttribute('data-keyboard-open', 'true')
  const headerBox = (await page.locator('header').boundingBox())!
  expect(headerBox.y).toBeGreaterThanOrEqual(0)
  const composerBox = (await composer.boundingBox())!
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(60 + 380)
  const surfaces = await page.evaluate(() => ({
    shell: getComputedStyle(document.querySelector('[data-fixture="visitor-chat"] > div')!)
      .backgroundColor,
    html: getComputedStyle(document.documentElement).backgroundColor,
  }))
  expect(surfaces.html).toBe(surfaces.shell)
})

test('the page surface and browser chrome follow the venue theme', async ({ page }) => {
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=long&motion=reduced&network=online&language=English&theme=dark',
  )
  await hideFrameworkDevChrome(page)
  await page.waitForSelector('html[data-visitor-chat]', { state: 'attached' })
  const surfaces = await page.evaluate(() => {
    const shell = document.querySelector('[data-fixture="visitor-chat"] > div') as HTMLElement
    return {
      shell: getComputedStyle(shell).backgroundColor,
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      themeColors: Array.from(document.querySelectorAll('meta[name="theme-color"]')).map(
        (meta) => (meta as HTMLMetaElement).content,
      ),
    }
  })
  expect(surfaces.html).toBe(surfaces.shell)
  expect(surfaces.body).toBe(surfaces.shell)
  expect(surfaces.themeColors.length).toBeGreaterThan(0)
  expect(surfaces.themeColors).not.toContain('#1F4E8C')
})

test('approved chat branding remains usable on a short mobile viewport', async ({
  page,
}, testInfo) => {
  const interceptedAssets: string[] = []
  await page.setViewportSize({
    width: Math.min(page.viewportSize()?.width ?? 390, 390),
    height: 420,
  })
  await page.route('**/dev-fixtures/visitor-brand-*.svg', async (route) => {
    interceptedAssets.push(route.request().url())
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
  await expect(header.locator('[data-on-banner]')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Great Lakes Discovery Museum' })).toHaveCSS(
    'color',
    'rgb(255, 255, 255)',
  )
  await expectViewportIntegrity(page)
  await expectComposerReachable(page)
  await expectTouchTargets(page)
  await expectAccessiblePage(page)
  await saveEvidence(page, testInfo, 'visitor-chat-approved-branding-short-mobile')
})

test('fresh chat branding delivery failure preserves short-mobile controls', async ({
  page,
}, testInfo) => {
  const interceptedAssets: string[] = []
  await page.setViewportSize({
    width: Math.min(page.viewportSize()?.width ?? 390, 390),
    height: 420,
  })
  // A fresh test context proves an actual failed delivery. WebKit can retain a
  // previously decoded image across reload, which does not exercise onError.
  await page.route('**/dev-fixtures/visitor-brand-*.svg', async (route) => {
    interceptedAssets.push(route.request().url())
    await route.fulfill({ status: 404, body: '' })
  })
  await page.goto(
    '/dev-fixtures/visitor-chat?mode=classic&state=idle&conversation=empty&motion=reduced&branding=approved&theme=forest',
  )
  await hideFrameworkDevChrome(page)
  const header = page.locator('header')
  await expect(header).toHaveAttribute('data-branding-banner-state', 'failed')
  await expect(header.locator('img')).toHaveCount(0)
  await expect.poll(() => interceptedAssets.length).toBe(2)
  await expect(header.locator('[data-on-banner]')).toHaveCount(0)
  const headerTextColor = await header.evaluate((node) => getComputedStyle(node).color)
  await expect(page.getByRole('heading', { name: 'Great Lakes Discovery Museum' })).toHaveCSS(
    'color',
    headerTextColor,
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

  await expect(page.locator('[data-fixture-state="thinking"]')).toBeAttached()
  await expect(page.locator('[data-fixture-state="thinking"] > div')).toBeVisible()
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

  await expect(page.locator('[data-fixture-state="speaking"]')).toBeAttached()
  await expect(page.locator('[data-fixture-state="speaking"] > div')).toBeVisible()
  await expect(page.getByText(/lake ecology gallery is on the upper floor/)).toBeVisible()
  const liveStatus = page.getByRole('status').filter({ hasText: 'Museum Guide is responding' })
  // This fixture already contains the first response delta. The pending status
  // must not linger once assistant text is available.
  await expect(liveStatus).toHaveCount(0)
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
