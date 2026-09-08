import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

function trpcSuccess(json: unknown) {
  return { contentType: 'application/json', body: JSON.stringify({ result: { data: { json } } }) }
}

function captureRuntimeErrors(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  return errors
}

test('typed founder responses stay compact, deterministic, and separate from approval', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390x844', 'One project covers representative widths.')
  const runtimeErrors = captureRuntimeErrors(page)
  const requests: unknown[] = []
  await page.route('**/api/trpc/admin.answerAgentQuestion**', async (route) => {
    requests.push(route.request().postDataJSON()['0'].json)
    await route.fulfill(
      trpcSuccess({
        questionId: 'fixture-multi-select',
        agentRunId: null,
        status: 'ANSWERED',
        runEligibleToResume: false,
        replayed: false,
        executionTriggered: false,
        dispatchStatus: 'NOT_NEEDED',
      }),
    )
  })
  await page.setViewportSize({ width: 320, height: 568 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`${baseUrl}/dev-fixtures/founder-question-types`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

  await expect(page.locator('[data-fixture="founder-question-types"]')).toBeVisible()
  const multi = page
    .getByRole('article')
    .filter({ hasText: 'Which access features are confirmed?' })
  const largePrint = multi.getByRole('button', { name: 'Large-print visitor guide' })
  await largePrint.focus()
  await expect(largePrint).toBeFocused()
  await page.keyboard.press('Enter')
  await multi.getByRole('button', { name: 'Step-free greenhouse entrance' }).click()
  await multi.getByLabel('Optional context').fill('Confirmed in the retained walkthrough.')
  await expect(largePrint).toHaveAttribute('aria-pressed', 'true')
  await multi.getByRole('button', { name: 'Answer agent' }).click()
  await expect(multi.getByRole('status')).toContainText('No run resumed and no action was approved')
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    questionId: 'fixture-multi-select',
    answer:
      'Selected: Step-free greenhouse entrance; Large-print visitor guide\nContext: Confirmed in the retained walkthrough.',
  })
  await expect(page.getByText(/Any action approval is a separate explicit step/)).toBeVisible()

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 820, height: 1_180 },
    { width: 1_024, height: 768 },
    { width: 1_440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    await expect
      .poll(() =>
        page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true)
    const axe = await new AxeBuilder({ page }).include('body').analyze()
    expect(axe.violations).toEqual([])
    const screenshot = testInfo.outputPath(`founder-question-types-${viewport.width}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach(`founder-question-types-${viewport.width}`, {
      path: screenshot,
      contentType: 'image/png',
    })
  }
  expect(runtimeErrors).toEqual([])
})
