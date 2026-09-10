import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
for (const width of [390, 768, 1280, 1440]) {
  test(`explicit duplicate review at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const submitted: string[] = []
    const held: { release?: () => void } = {}
    await page.route('**/api/trpc/**', async (route) => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1)
      const respond = (json: unknown) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ result: { data: { json } } }),
        })
      if (method === 'admin.previewSemanticVenueUpdate')
        return respond({
          proposalStatus: 'APPROVED',
          classification: 'DUPLICATE_NOOP',
          operationCount: 0,
          authority: 'VENUE_CONFIRMED',
          confidence: 1,
          blockers: [],
          questions: [],
          previewHash: 'a'.repeat(64),
          venuePackagePatch: null,
          operationalUpdateDraft: null,
        })
      if (method === 'admin.resolveSupportSemanticDuplicate') {
        submitted.push(route.request().postData() ?? '')
        if (submitted.length === 1) {
          await new Promise<void>((resolve) => {
            held.release = resolve
          })
          return route.abort('failed')
        }
        return respond({
          resolutionId: '22222222-2222-4222-8222-222222222222',
          outcome: 'DUPLICATE_NOOP',
          replayed: true,
          canonicalKnowledgeChanged: false,
          approvalGranted: false,
          completionGranted: false,
          currentFulfillmentVerified: false,
        })
      }
      throw new Error(`Unexpected duplicate fixture API action: ${method}`)
    })
    await page.goto('/dev-fixtures/support-duplicate-review')
    await page.getByRole('button', { name: 'Build semantic change preview' }).click()
    await page.getByRole('button', { name: 'Compute semantic preview' }).focus()
    await page.keyboard.press('Enter')
    const record = page.getByRole('button', { name: 'Record duplicate review', exact: true })
    await expect(record).toBeDisabled()
    await page
      .getByRole('textbox', { name: 'Review note', exact: true })
      .fill(
        'Reviewed the approved proposal against the existing gallery guidance; the wording and closing time already match.',
      )
    await expect(record).toBeDisabled()
    await page.getByLabel('I confirm the proposal duplicates the current guidance.').focus()
    await page.keyboard.press('Space')
    await record.click()
    await expect(page.getByRole('button', { name: /^Recording duplicate review/ })).toBeDisabled()
    await expect(page.getByLabel('Visitor-facing content')).toBeDisabled()
    await page.screenshot({
      path: info.outputPath(`duplicate-pending-${width}.png`),
      fullPage: true,
    })
    held.release?.()
    await expect(page.getByRole('button', { name: 'Retry exact duplicate review' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Review note', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Compute semantic preview' })).toBeDisabled()
    await page.screenshot({
      path: info.outputPath(`duplicate-unknown-${width}.png`),
      fullPage: true,
    })
    await page.getByRole('button', { name: 'Retry exact duplicate review' }).click()
    await expect(
      page
        .getByRole('group', { name: 'Semantic change preview' })
        .getByText('Duplicate review recorded', { exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText('The proposal has changed since this receipt was recorded.'),
    ).toBeVisible()
    await expect(
      page
        .getByRole('region', { name: 'Retained review history' })
        .getByRole('button', { name: 'Build semantic change preview' }),
    ).toHaveCount(0)
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toBe(submitted[0])
    await expect(
      page.getByRole('button', { name: 'Record duplicate review', exact: true }),
    ).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    )
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: info.outputPath(`duplicate-final-${width}.png`), fullPage: true })
  })
}
