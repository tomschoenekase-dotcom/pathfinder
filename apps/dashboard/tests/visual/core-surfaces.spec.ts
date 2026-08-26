import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'
const visitorBaseUrl = process.env.PLAYWRIGHT_VISITOR_BASE_URL ?? 'http://127.0.0.1:3000'

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

async function expectViewportIntegrity(page: Page) {
  await expect
    .poll(() => page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1))
    .toBe(true)
}

async function expectFixedViewportShell(page: Page) {
  const dimensions = await page.evaluate(() => ({
    bodyHeight: document.body.scrollHeight,
    htmlHeight: document.documentElement.scrollHeight,
    scrollY: window.scrollY,
    viewportHeight: window.innerHeight,
  }))
  // Next.js development tooling may extend the document element outside the product body.
  // The guest shell itself must remain viewport-bound and the page must not be scrolled.
  expect(dimensions.bodyHeight, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewportHeight + 1,
  )
  expect(dimensions.scrollY, JSON.stringify(dimensions)).toBe(0)
}

async function hideFrameworkDevChrome(page: Page, options: { clerk?: boolean } = {}) {
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  if (!options.clerk) return

  const keylessPrompt = page.getByRole('button', { name: 'Keyless prompt' })
  await keylessPrompt
    .first()
    .waitFor({ state: 'attached', timeout: 2_000 })
    .catch(() => undefined)
  await keylessPrompt.evaluateAll((buttons) => {
    for (const button of buttons) {
      let current: Element | null = button
      while (current?.parentElement && current.parentElement !== document.body) {
        if (window.getComputedStyle(current).position === 'fixed') {
          current.remove()
          current = null
          break
        }
        current = current.parentElement
      }
      current?.remove()
    }
  })
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

async function saveViewportEvidence(page: Page, testInfo: TestInfo, name: string) {
  const screenshot = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath(`${name}.png`),
  })
  expect(screenshot.byteLength).toBeGreaterThan(10_000)
}

test('Guest PathFinder route planning is usable in a real browser', async ({ page }, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(
    `${visitorBaseUrl}/dev-fixtures/visitor-chat?mode=character&state=idle&conversation=long&motion=reduced&voice=idle&route=ready`,
  )
  await hideFrameworkDevChrome(page)

  await expect(page.getByRole('heading', { name: 'Museum Guide' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Museum Tochi character status' })).toBeVisible()
  const plannerToggle = page.getByRole('button', { name: 'Plan a route' })
  await plannerToggle.focus()
  await expect(plannerToggle).toBeFocused()
  await plannerToggle.press('Enter')
  await page.getByLabel('Use only connections marked accessible').check()
  await page.getByRole('button', { name: 'Find route' }).click()
  await expect(page.getByText('Main entrance to Lake gallery')).toBeVisible()
  await expect(page.getByText('Take the lift to the upper floor and turn left.')).toBeVisible()

  await expectViewportIntegrity(page)
  await expectFixedViewportShell(page)
  await expectAccessiblePage(page)
  await saveViewportEvidence(page, testInfo, 'guest-route-planner')
  expect(runtimeErrors).toEqual([])
})

test('single-venue client home remains simple and responsive', async ({ page }, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/portal-home?state=live`)
  await hideFrameworkDevChrome(page, { clerk: true })

  await expect(
    page.locator('[data-fixture="portal-home"][data-fixture-state="live"]'),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Great Lakes Discovery Museum' })).toBeVisible()
  await expect(page.getByLabel('Viewing venue')).toHaveCount(0)
  const firstAction = page.getByRole('link').first()
  await firstAction.focus()
  await expect(firstAction).toBeFocused()

  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveViewportEvidence(page, testInfo, 'client-portal-live')
  expect(runtimeErrors).toEqual([])
})

test('remote onboarding questions remain clear and keyboard reachable', async ({
  page,
}, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/remote-onboarding?state=questions`)
  await hideFrameworkDevChrome(page, { clerk: true })

  await expect(
    page.locator('[data-fixture="remote-onboarding"][data-fixture-state="questions"]'),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Focused questions' })).toBeVisible()
  await expect(page.getByText('Accessible entrance details')).toBeVisible()
  const helpLink = page.getByRole('link', { name: 'Ask Torchiko for help' }).first()
  await helpLink.focus()
  await expect(helpLink).toBeFocused()

  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveViewportEvidence(page, testInfo, 'remote-onboarding-questions')
  expect(runtimeErrors).toEqual([])
})

test('Founder Control Room shell is responsive and restores mobile navigation focus', async ({
  page,
}, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/authenticated-operations?surface=admin`)
  await hideFrameworkDevChrome(page, { clerk: true })

  await expect(
    page.locator('[data-fixture="authenticated-operations"][data-fixture-surface="admin"]'),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Founder Control Room' })).toBeVisible()
  await expect(page.getByText('Pricing and production release remain founder-gated.')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Candidate 67f48d18/ })).toBeVisible()
  await expect(page.getByText('Evidence only', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Claim-review agreement' })).toBeVisible()
  await expect(page.getByText('Descriptive evidence only', { exact: true })).toBeVisible()
  await page.getByText('Gates, limits, and rollback', { exact: true }).click()
  await expect(page.getByText('Production activation remains founder-gated.')).toBeVisible()

  const navigationTrigger = page.getByRole('button', { name: 'Open navigation' })
  if (await navigationTrigger.isVisible()) {
    await navigationTrigger.focus()
    await navigationTrigger.press('Enter')
    await expect(page.getByRole('navigation', { name: 'Torchiko OS navigation' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Control room' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await page.keyboard.press('Escape')
    await expect(navigationTrigger).toBeFocused()
  } else {
    const search = page.getByRole('button', { name: 'Search Admin OS' })
    await search.focus()
    await search.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Admin OS command search' })).toBeVisible()
    await page.getByRole('button', { name: 'Close search' }).click()
    await expect(search).toBeFocused()
  }

  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveViewportEvidence(page, testInfo, 'founder-control-room')
  expect(runtimeErrors).toEqual([])
})

test('Founder trust evidence remains readable and truthful across real browser widths', async ({
  page,
}, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/agent-trust-evidence`)
  await hideFrameworkDevChrome(page, { clerk: true })

  await expect(page.locator('[data-fixture="agent-trust-evidence"]')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Has the AI workforce earned more trust?' }),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Structured trust signals' })).toBeVisible()
  await expect(page.getByText('Canonical rollbacks')).toBeVisible()
  await expect(page.getByText('Policy violations')).toBeVisible()
  await expect(page.getByText('Confidence pairs')).toBeVisible()
  await expect(
    page.getByText(/No reliability score, trend claim, or permission change is inferred/),
  ).toBeVisible()

  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveViewportEvidence(page, testInfo, 'founder-agent-trust-evidence')
  expect(runtimeErrors).toEqual([])
})

test('exact-scoped Internal Workspace remains usable across real browser widths', async ({
  page,
}, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/authenticated-operations?surface=workspace`)
  await hideFrameworkDevChrome(page, { clerk: true })

  await expect(
    page.locator('[data-fixture="authenticated-operations"][data-fixture-surface="workspace"]'),
  ).toBeVisible()
  await expect(page.getByText('Venue scope')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Harbor Discovery Museum' })).toBeVisible()
  const contentLink = page.getByRole('link', { name: /Universal content/ })
  await expect(contentLink).toHaveAttribute('aria-current', 'page')
  await contentLink.focus()
  await expect(contentLink).toBeFocused()
  await expect(page.getByText('Superseded and excluded from guest answers')).toBeVisible()

  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveViewportEvidence(page, testInfo, 'internal-workspace-content')
  expect(runtimeErrors).toEqual([])
})

test('bounded venue feature access is readable and keyboard reachable', async ({
  page,
}, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.goto(
    `${dashboardBaseUrl}/dev-fixtures/authenticated-operations?surface=feature-access`,
  )
  await hideFrameworkDevChrome(page, { clerk: true })

  await expect(
    page.locator(
      '[data-fixture="authenticated-operations"][data-fixture-surface="feature-access"]',
    ),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Feature access' })).toBeVisible()
  await expect(page.getByText('Two-key activation')).toBeVisible()
  await expect(page.getByText('Not entitled')).toBeVisible()
  const submit = page.getByRole('button', { name: 'Append Voice grant' })
  await expect(submit).toBeDisabled()
  await page.getByLabel('Audit reason').fill('Synthetic browser proof')
  await page.getByRole('checkbox').check()
  await submit.focus()
  await expect(submit).toBeFocused()
  await expect(submit).toBeEnabled()

  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveViewportEvidence(page, testInfo, 'venue-feature-access')
  expect(runtimeErrors).toEqual([])
})
