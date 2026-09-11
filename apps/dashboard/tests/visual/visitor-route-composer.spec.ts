import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'

const visitorBaseUrl = process.env.PLAYWRIGHT_VISITOR_BASE_URL ?? 'http://127.0.0.1:3000'
const compactViewports = [
  { name: 'phone-390x844', width: 390, height: 844 },
  { name: 'phone-320x568', width: 320, height: 568 },
  { name: 'phone-landscape-568x320', width: 568, height: 320 },
] as const

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
})

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

async function expectAccessiblePage(page: Page) {
  const result = await new AxeBuilder({ page }).include('body').analyze()
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([])
}

async function clippedGeometry(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    let visibleTop = Math.max(0, rect.top)
    let visibleRight = Math.min(window.innerWidth, rect.right)
    let visibleBottom = Math.min(window.innerHeight, rect.bottom)
    let visibleLeft = Math.max(0, rect.left)
    let ancestor = element.parentElement

    while (ancestor) {
      const style = window.getComputedStyle(ancestor)
      const ancestorRect = ancestor.getBoundingClientRect()
      if (['auto', 'clip', 'hidden', 'scroll'].includes(style.overflowY)) {
        visibleTop = Math.max(visibleTop, ancestorRect.top)
        visibleBottom = Math.min(visibleBottom, ancestorRect.bottom)
      }
      if (['auto', 'clip', 'hidden', 'scroll'].includes(style.overflowX)) {
        visibleLeft = Math.max(visibleLeft, ancestorRect.left)
        visibleRight = Math.min(visibleRight, ancestorRect.right)
      }
      ancestor = ancestor.parentElement
    }

    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      height: rect.height,
      width: rect.width,
      visibleHeight: Math.max(0, visibleBottom - visibleTop),
      visibleWidth: Math.max(0, visibleRight - visibleLeft),
    }
  })
}

async function expectFullyUnclipped(locator: Locator) {
  const geometry = await clippedGeometry(locator)
  expect(geometry.visibleHeight, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
    geometry.height - 1,
  )
  expect(geometry.visibleWidth, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.width - 1)
}

async function expectHitTarget(locator: Locator) {
  const hit = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return [rect.top + rect.height / 2, rect.bottom - 2].map((y) => {
      const target = document.elementFromPoint(rect.left + rect.width / 2, y)
      return target === element || (target ? element.contains(target) : false)
    })
  })
  expect(hit).toEqual([true, true])
}

async function expectScrollableConversationWithPersistentComposer(page: Page) {
  const conversation = page.getByRole('log', { name: 'Conversation' })
  const composer = page.getByRole('textbox')
  const composerField = composer.locator('..')
  const send = page.getByRole('button', { name: 'Send message' })
  const metrics = await conversation.evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
  }))
  expect(metrics.clientHeight, JSON.stringify(metrics)).toBeGreaterThan(0)
  expect(metrics.scrollHeight, JSON.stringify(metrics)).toBeGreaterThan(metrics.clientHeight)
  await expectFullyUnclipped(composerField)
  await expectFullyUnclipped(send)
  await expectHitTarget(send)

  await conversation.evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  await expect.poll(() => conversation.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  await expectFullyUnclipped(composerField)
  await expectHitTarget(send)
  await conversation.evaluate((node) => {
    node.scrollTop = 0
  })
}

async function expectPersistentActiveVoiceLayout(page: Page) {
  const conversation = page.getByRole('log', { name: 'Conversation' })
  const voiceControls = page.getByRole('region', { name: 'Voice controls' })
  const endVoice = page.getByRole('button', { name: 'End voice conversation' })
  const transcript = page.getByLabel('Voice transcript')
  const composer = page.getByRole('textbox')
  const composerField = composer.locator('..')
  const send = page.getByRole('button', { name: 'Send message' })

  await composer.fill(
    'Please plan a quiet route.\nAvoid the stairs.\nInclude a place to rest.\nKeep it suitable for children.',
  )
  await conversation.evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  const conversationMetrics = await conversation.evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    scrollTop: node.scrollTop,
  }))
  expect(conversationMetrics.clientHeight, JSON.stringify(conversationMetrics)).toBeGreaterThan(0)
  expect(conversationMetrics.scrollHeight, JSON.stringify(conversationMetrics)).toBeGreaterThan(
    conversationMetrics.clientHeight,
  )
  expect(conversationMetrics.scrollTop, JSON.stringify(conversationMetrics)).toBeGreaterThan(0)

  await expectFullyUnclipped(voiceControls)
  await expectFullyUnclipped(composerField)
  await expectFullyUnclipped(send)
  await expectHitTarget(send)
  const [voiceGeometry, composerGeometry] = await Promise.all([
    clippedGeometry(voiceControls),
    clippedGeometry(composerField),
  ])
  expect(
    voiceGeometry.bottom,
    JSON.stringify({ voiceGeometry, composerGeometry }),
  ).toBeLessThanOrEqual(composerGeometry.top + 1)

  const maximumVoiceScroll = await voiceControls.evaluate(
    (node) => node.scrollHeight - node.clientHeight,
  )
  for (const voiceScrollTop of [0, maximumVoiceScroll / 2, maximumVoiceScroll]) {
    await voiceControls.evaluate((node, scrollTop) => {
      node.scrollTop = scrollTop
    }, voiceScrollTop)
    await expectFullyUnclipped(endVoice)
    await expectHitTarget(endVoice)
  }

  await transcript.focus()
  await expect(transcript).toBeFocused()
  const transcriptGeometry = await clippedGeometry(transcript)
  expect(transcriptGeometry.visibleHeight, JSON.stringify(transcriptGeometry)).toBeGreaterThan(0)
  await expectFullyUnclipped(endVoice)
  await expectHitTarget(endVoice)
  await endVoice.focus()
  await expect(endVoice).toBeFocused()
}

async function saveEvidence(page: Page, testInfo: TestInfo, name: string) {
  const screenshot = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath(`${name}.png`),
  })
  expect(screenshot.byteLength).toBeGreaterThan(10_000)
}

test('guest route, voice stop, and composer stay usable on compact screens', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390x844', 'compact viewport matrix runs once')
  const runtimeErrors = captureRuntimeErrors(page)

  for (const viewport of compactViewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto(
      `${visitorBaseUrl}/dev-fixtures/visitor-chat?mode=character&state=idle&conversation=long&motion=reduced&voice=idle&route=ready`,
    )
    await hideFrameworkDevChrome(page)
    const conversation = page.getByRole('log', { name: 'Conversation' })
    const planner = page.getByRole('button', { name: 'Plan a route' })
    const voiceStart = page.getByRole('button', { name: 'Start voice conversation' })
    await expect(conversation.getByRole('button', { name: 'Plan a route' })).toHaveCount(1)
    expect(
      await conversation.evaluate(
        (node, child) => node.contains(child),
        await voiceStart.elementHandle(),
      ),
    ).toBe(false)
    await planner.focus()
    await planner.press('Enter')
    const accessibleOnly = page.getByLabel('Use only connections marked accessible')
    if (!(await accessibleOnly.isChecked())) await accessibleOnly.press('Space')
    const findRoute = page.getByRole('button', { name: 'Find route' })
    await findRoute.focus()
    await findRoute.press('Enter')
    await expect(page.getByText('Main entrance to Lake gallery')).toBeVisible()
    await expectScrollableConversationWithPersistentComposer(page)
    await expectFullyUnclipped(voiceStart)
    await expectAccessiblePage(page)
    await saveEvidence(page, testInfo, `guest-route-${viewport.name}`)

    await page.goto(
      `${visitorBaseUrl}/dev-fixtures/visitor-chat?mode=character&state=idle&conversation=long&motion=reduced&voice=speaking&route=ready`,
    )
    await hideFrameworkDevChrome(page)
    const activePlanner = page.getByRole('button', { name: 'Plan a route' })
    await activePlanner.focus()
    await activePlanner.press('Enter')
    const activeFindRoute = page.getByRole('button', { name: 'Find route' })
    await activeFindRoute.focus()
    await activeFindRoute.press('Enter')
    await expect(page.getByText('Main entrance to Lake gallery')).toBeVisible()
    await expectPersistentActiveVoiceLayout(page)
    await expectAccessiblePage(page)
    await saveEvidence(page, testInfo, `guest-active-voice-${viewport.name}`)
  }

  expect(runtimeErrors).toEqual([])
})
