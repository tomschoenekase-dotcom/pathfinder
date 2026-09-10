import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

for (const width of [390, 768, 1280, 1440]) {
  test(`reviewed support decline at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width <= 768 ? 1100 : 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const declineInputs: unknown[] = []
    let declineAttempt = 0
    const held: { release?: () => void } = {}

    await page.route('**/api/trpc/**', async (route) => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1)!
      if (method === 'admin.recordSupportReviewedDecline') {
        declineAttempt += 1
        declineInputs.push(JSON.parse(route.request().postData() ?? '{}'))
        if (declineAttempt === 1) {
          await new Promise<void>((resolve) => {
            held.release = resolve
          })
          return route.abort('failed')
        }
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            result: {
              data: {
                json: {
                  resolutionId: 'resolution-1',
                  outcome: 'REVIEWED_DECLINE',
                  replayed: true,
                  canonicalKnowledgeChanged: false,
                  currentFulfillmentVerified: false,
                },
              },
            },
          }),
        })
      }
      if (method === 'admin.getSupportCompletionPreview') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            result: {
              data: {
                json: {
                  outcome: 'RESOLVED',
                  fulfillmentDigest: 'a'.repeat(64),
                  expectedVersion: 7,
                  reviewedDeclines: [
                    {
                      proposalSummary: 'Replace the accessible entrance directions.',
                      reviewNote:
                        'The source did not establish a permanent route. Keep the reviewed wording.',
                    },
                  ],
                },
              },
            },
          }),
        })
      }
      if (method === 'admin.reviewKnowledgeProposal') {
        throw new Error('Founder approval must stay disabled while decline outcome is retained')
      }
      throw new Error(`Unexpected fixture API method: ${method}`)
    })

    await page.goto('/dev-fixtures/support-reviewed-decline')
    const pendingCard = page.locator('article').filter({
      hasText: 'Replace the accessible entrance directions.',
    })
    await expect(pendingCard.getByRole('button', { name: 'Reject proposal' })).toHaveCount(0)
    await pendingCard
      .getByLabel('Decline review note')
      .fill('The source does not support this change.')
    await pendingCard.getByLabel(/I confirm this proposal should be declined/).focus()
    await page.keyboard.press('Space')
    await pendingCard.getByRole('button', { name: 'Record reviewed decline' }).focus()
    await page.keyboard.press('Enter')
    await expect(
      pendingCard.getByRole('button', { name: 'Recording reviewed decline…' }),
    ).toBeDisabled()
    await page.screenshot({ path: info.outputPath(`decline-pending-${width}.png`), fullPage: true })
    held.release?.()
    await expect(
      pendingCard.getByRole('button', { name: 'Retry exact reviewed decline' }),
    ).toBeVisible()
    await page.screenshot({ path: info.outputPath(`decline-unknown-${width}.png`), fullPage: true })
    const firstInput = JSON.stringify(declineInputs[0])
    await pendingCard.getByRole('button', { name: 'Retry exact reviewed decline' }).focus()
    await page.keyboard.press('Enter')
    await expect(pendingCard.getByText('Reviewed decline recorded')).toBeVisible()
    expect(JSON.stringify(declineInputs[1])).toBe(firstInput)
    await expect(pendingCard.getByRole('button', { name: 'Approve evidence' })).toHaveCount(0)

    const rejectedCard = page.locator('article').filter({
      hasText: 'Describe a seasonal route as permanent.',
    })
    await expect(
      rejectedCard.getByRole('button', { name: 'Record reviewed decline' }),
    ).toBeVisible()
    await expect(
      page.getByText('The proposal has changed since this receipt was recorded.'),
    ).toBeVisible()

    await page
      .getByLabel('Completion message to client')
      .fill(
        'We reviewed your request. The existing visitor guidance remains unchanged.\nThank you for the supporting detail.',
      )
    await page.getByRole('button', { name: 'Review completion outcome' }).click()
    const completion = page.getByRole('region', { name: 'Completion review' })
    const completionFacts = completion.getByText('Declined changes')
    const confirmation = completion.getByLabel(/I confirm this conversation is complete/)
    await expect(completion.getByText('Request resolved')).toBeVisible()
    await expect(completionFacts).toBeVisible()
    const factsBox = await completionFacts.boundingBox()
    const confirmationBox = await confirmation.boundingBox()
    expect(factsBox && confirmationBox && factsBox.y < confirmationBox.y).toBe(true)

    const founder = page.getByRole('region', { name: 'Founder approval context' })
    await expect(founder.getByText('Declined changes')).toBeVisible()
    await expect(
      founder.getByText(
        'We reviewed your request. The existing visitor guidance remains unchanged. Thank you for the supporting detail.',
      ),
    ).toBeVisible()

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: info.outputPath(`decline-final-${width}.png`), fullPage: true })
  })
}
