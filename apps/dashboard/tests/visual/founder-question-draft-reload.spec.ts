import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('unsent founder answer survives reload without submitting or granting authority', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390x844', 'One invocation checks four viewports.')
  const errors: string[] = []
  const mutations: unknown[] = []
  const unexpectedMutations: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/trpc/**', async (route) => {
    if (route.request().method() === 'POST') unexpectedMutations.push(route.request().url())
    await route.abort()
  })
  let failAnswer = true
  await page.route('**/api/trpc/admin.answerAgentQuestion**', async (route) => {
    mutations.push(route.request().postDataJSON()['0'].json)
    await route.fulfill(
      failAnswer
        ? {
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                json: {
                  message: 'Fixture save failed',
                  code: -32603,
                  data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
                },
              },
            }),
          }
        : {
            contentType: 'application/json',
            body: JSON.stringify({
              result: {
                data: {
                  json: {
                    questionId: 'fixture-foundational-identity',
                    agentRunId: 'fixture-run-identity',
                    status: 'ANSWERED',
                    runEligibleToResume: true,
                    replayed: false,
                    executionTriggered: true,
                    dispatchStatus: 'ENQUEUED',
                  },
                },
              },
            }),
          },
    )
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${baseUrl}/dev-fixtures/founder-question-triage`)
  const title = page.getByText('Which building does the uploaded handbook describe?')
  const card = title.locator('xpath=ancestor::details')
  const answer = card.getByLabel('Your answer')
  const draft = 'The cover identifies North Campus; verify the footer before applying changes.'
  await title.click()
  await answer.fill(draft)
  await page.reload()
  await title.click()
  await expect(answer).toHaveValue(draft)
  expect(mutations).toEqual([])
  await card.getByRole('button', { name: 'Answer agent', exact: true }).click()
  await expect(
    card.getByRole('status').filter({ hasText: 'response could not be confirmed' }),
  ).toBeVisible()
  await page.reload()
  await title.click()
  await expect(answer).toHaveValue(draft)
  expect(mutations).toHaveLength(1)
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await answer.focus()
    await expect(answer).toBeFocused()
    expect(await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth + 1)).toBe(
      true,
    )
    expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([])
    await page.screenshot({
      path: testInfo.outputPath(`founder-draft-restored-${viewport.width}.png`),
      fullPage: true,
    })
  }
  failAnswer = false
  await card.getByRole('button', { name: 'Answer agent', exact: true }).click()
  await expect(card.getByRole('status')).toContainText('queued for its worker to resume')
  await page.reload()
  await title.click()
  await expect(answer).toHaveValue('')
  expect(mutations).toHaveLength(2)
  expect(mutations[1]).toEqual({
    tenantId: 'fixture-tenant',
    venueId: 'fixture-venue',
    questionId: 'fixture-foundational-identity',
    expectedUpdatedAt: '2026-08-29T07:00:00.000Z',
    outcome: 'ANSWERED',
    answer: draft,
  })
  expect(errors).toEqual([])
  expect(unexpectedMutations).toEqual([])
})
