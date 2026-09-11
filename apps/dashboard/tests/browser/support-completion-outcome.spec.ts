import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

for (const width of [390, 768, 1280, 1440]) {
  test(`structured support completion at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width <= 768 ? 1100 : 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    let previewAttempt = 0
    let completionAttempt = 0
    const heldPreview: { release?: () => void } = {}
    const completionInputs: unknown[] = []

    await page.route('**/api/trpc/**', async (route) => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1)!
      if (method === 'admin.getSupportCompletionPreview') {
        previewAttempt += 1
        if (previewAttempt === 1) {
          await new Promise<void>((resolve) => {
            heldPreview.release = resolve
          })
        }
        if (previewAttempt <= 2) return route.abort('failed')
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            result: {
              data: {
                json: {
                  outcome: 'MIXED',
                  fulfillmentDigest: 'a'.repeat(64),
                  expectedVersion: 7,
                },
              },
            },
          }),
        })
      }
      if (method === 'admin.completeSupportRequest') {
        completionAttempt += 1
        completionInputs.push(JSON.parse(route.request().postData() ?? '{}'))
        if (completionAttempt === 1) return route.abort('failed')
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            result: { data: { json: { status: 'COMPLETED', replayed: true } } },
          }),
        })
      }
      throw new Error(`Unexpected fixture API method: ${method}`)
    })

    await page.goto('/dev-fixtures/support-completion-outcome')
    for (const label of [
      'Updates applied',
      'No change needed',
      'Updates and reviewed items',
      'Request resolved',
    ])
      await expect(
        page
          .getByRole('region', { name: 'Client-visible completion messages' })
          .getByText(label, { exact: true }),
      ).toBeVisible()

    await page.getByRole('button', { name: 'Review completion outcome' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Reviewing outcome…' })).toBeDisabled()
    await page.screenshot({
      path: info.outputPath(`completion-loading-${width}.png`),
      fullPage: true,
    })
    heldPreview.release?.()
    await expect(page.getByRole('alert').filter({ hasText: 'We could not confirm' })).toContainText(
      /could not confirm/i,
    )
    await page.getByRole('button', { name: 'Review completion outcome' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'We could not confirm' })).toContainText(
      /could not confirm/i,
    )
    await page.getByRole('button', { name: 'Review completion outcome' }).click()
    await expect(page.getByText('Updates and reviewed items', { exact: true })).toHaveCount(2)

    await page
      .getByLabel('Completion message to client')
      .fill('The approved update was applied; the reviewed duplicate needed no change.')
    // Editing after preview deliberately invalidates the digest, so review once more.
    await page.getByRole('button', { name: 'Review completion outcome' }).click()
    await expect(page.getByText('Updates and reviewed items', { exact: true })).toHaveCount(2)
    await page.getByLabel(/I confirm this conversation is complete/).focus()
    await page.keyboard.press('Space')
    await expect(page.getByLabel(/I confirm this conversation is complete/)).toBeChecked()
    await page.getByRole('button', { name: 'Complete support request' }).click()
    await expect(page.getByRole('button', { name: 'Retry exact completion' })).toBeVisible()
    await page.screenshot({
      path: info.outputPath(`completion-unknown-${width}.png`),
      fullPage: true,
    })
    const first = JSON.stringify(completionInputs[0])
    await page.getByRole('button', { name: 'Retry exact completion' }).click()
    await expect(page.getByText(/support request was completed/i)).toBeVisible()
    expect(JSON.stringify(completionInputs[1])).toBe(first)

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({
      path: info.outputPath(`completion-final-${width}.png`),
      fullPage: true,
    })
  })
}
