import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('current visitor-feedback hazard evidence remains readable across viewports', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'phone-390x844')
    await page.setViewportSize({ width: 320, height: 568 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.route('**/api/trpc/admin.visitorFeedbackHazardEvidence**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        result: {
          data: {
            json: {
              schemaVersion: 1,
              effect: 'READ_ONLY',
              event: {
                id: '11111111-1111-4111-8111-111111111111',
                tenantId: 'tenant_fixture',
                venueId: 'venue_fixture',
                occurrenceCount: 2,
                lastOccurredAt: '2026-09-07T20:05:00.000Z',
              },
              currentFeedback: {
                id: 'feedback_fixture',
                rating: 'HELPFUL',
                reason: 'The answer is correct.',
                updatedAt: '2026-09-07T20:07:00.000Z',
                sessionId: 'session_fixture',
                linkedMessage: {
                  id: 'message_fixture',
                  role: 'assistant',
                  content: 'The east entrance is open.',
                  createdAt: '2026-09-07T19:58:00.000Z',
                },
              },
              boundaries: {
                signalUnverified: true,
                feedbackMutable: true,
                currentFeedbackOnly: true,
                venuePublicationAuthorized: false,
                operationalMutationAuthorized: false,
              },
            },
          },
        },
      }),
    }),
  )

  await page.goto(
    `${dashboardBaseUrl}/dev-fixtures/agent-trust-evidence?focus=visitor-feedback-hazard`,
  )
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  await expect(
    page.getByRole('heading', { name: 'Potential visitor-reported safety hazard' }),
  ).toBeVisible()
  const inspect = page.getByRole('button', { name: 'Inspect current visitor feedback' })
  await inspect.focus()
  await expect(inspect).toBeFocused()
  await inspect.click()
  await expect(page.getByText('Current mutable feedback record')).toBeVisible()
  await expect(page.getByText('Helpful')).toBeVisible()
  await expect(page.getByText('The answer is correct.')).toBeVisible()
  await expect(page.getByText(/unverified signal/i)).toBeVisible()
  await expect(page.getByText(/does not publish a venue notice/i)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Review linked conversation' })).toHaveAttribute(
    'href',
    '/admin/clients/tenant_fixture/venues/venue_fixture/chatlogs/session_fixture',
  )
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath(`visitor-feedback-hazard-${page.viewportSize()?.width}.png`),
    fullPage: true,
  })
  await page.getByRole('region', { name: 'Current visitor feedback evidence' }).screenshot({
    path: testInfo.outputPath(`visitor-feedback-panel-${page.viewportSize()?.width}.png`),
  })
  if (testInfo.project.name === 'desktop-1440x900') {
    await page.setViewportSize({ width: 1024, height: 768 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('region', { name: 'Current visitor feedback evidence' }).screenshot({
      path: testInfo.outputPath('visitor-feedback-panel-1024.png'),
    })
  }
})
