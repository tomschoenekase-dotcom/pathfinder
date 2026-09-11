import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

function trpcSuccess(json: unknown) {
  return {
    contentType: 'application/json',
    body: JSON.stringify({ result: { data: { json } } }),
  }
}

function captureRuntimeErrors(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  return errors
}

test('recorded founder answer retains an exact retry without widening authority', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390x844', 'One project covers all four viewports.')
  const runtimeErrors = captureRuntimeErrors(page)
  const requests: unknown[] = []
  let attempt = 0
  await page.route('**/api/trpc/admin.answerAgentQuestion**', async (route) => {
    requests.push(route.request().postDataJSON()['0'].json)
    attempt += 1
    await route.fulfill(
      trpcSuccess({
        questionId: 'fixture-foundational-identity',
        agentRunId: 'fixture-run-identity',
        status: 'ANSWERED',
        runEligibleToResume: true,
        replayed: attempt > 1,
        executionTriggered: attempt > 1,
        dispatchStatus: attempt > 1 ? 'ENQUEUED' : 'UNCONFIRMED',
      }),
    )
  })
  await page.setViewportSize({ width: 320, height: 568 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`${baseUrl}/dev-fixtures/founder-question-triage`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

  const question = page.getByText('Which building does the uploaded handbook describe?')
  const card = question.locator('xpath=ancestor::details')
  await question.click()
  const answer = card.getByLabel('Your answer')
  await answer.focus()
  await expect(answer).toBeFocused()
  await card.getByRole('button', { name: 'North Campus' }).click()
  await card.getByRole('button', { name: 'Answer agent' }).click()

  await expect(card.getByRole('status')).toContainText(
    'Answer recorded, but worker wake-up could not be confirmed.',
  )
  await expect(answer).toBeDisabled()
  await expect(card.getByRole('button', { name: 'Dismiss with note' })).toBeDisabled()
  await expect(card.getByRole('button', { name: 'Retry worker wake-up' })).toBeVisible()
  const unconfirmedScreenshot = testInfo.outputPath('founder-answer-unconfirmed-320.png')
  await page.screenshot({ path: unconfirmedScreenshot, fullPage: true })
  await testInfo.attach('founder-answer-unconfirmed-320', {
    path: unconfirmedScreenshot,
    contentType: 'image/png',
  })

  await card.getByRole('button', { name: 'Retry worker wake-up' }).focus()
  await expect(card.getByRole('button', { name: 'Retry worker wake-up' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(card.getByRole('status')).toContainText('queued for its worker to resume')
  expect(requests).toHaveLength(2)
  expect(requests[0]).toEqual({
    tenantId: 'fixture-tenant',
    venueId: 'fixture-venue',
    questionId: 'fixture-foundational-identity',
    expectedUpdatedAt: '2026-08-29T07:00:00.000Z',
    outcome: 'ANSWERED',
    answer: 'North Campus',
  })
  expect(requests[1]).toEqual(requests[0])

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
    expect(
      axe.violations.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
      })),
    ).toEqual([])
    const screenshot = testInfo.outputPath(`founder-answer-recovered-${viewport.width}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach(`founder-answer-recovered-${viewport.width}`, {
      path: screenshot,
      contentType: 'image/png',
    })
  }
  expect(runtimeErrors).toEqual([])
})
