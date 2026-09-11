import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const reference = {
  reviewReceiptId: '22222222-2222-4222-8222-222222222222',
  expectedSnapshotHash: 'e'.repeat(64),
  claimId: 'closure-0',
}
const desired = {
  title: 'North entrance closure',
  category: 'TEMPORARY_CLOSURE',
  content: 'The north entrance is closed for maintenance.',
  isEnabled: true,
}
const dates = { validFrom: '2030-01-01T10:05:12.123Z', validUntil: '2030-01-03T16:07:23.456Z' }
const sourceItem = {
  key: 'north-entrance-reviewed',
  reference,
  desired,
  ...dates,
  reviewedAt: '2026-08-25T13:00:00.000Z',
  sourceNames: [
    'north-entrance-reviewed-maintenance-schedule.pdf',
    'front-desk-confirmed-entrance-notice.pdf',
  ],
}
const expiryMessage = 'Reviewed source has expired. Refresh sources before previewing.'

for (const width of [390, 820, 1440]) {
  test(`reviewed dated source selection at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 820 ? 1180 : 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const previewInputs: Array<Record<string, unknown>> = []
    const draftInputs: Array<Record<string, unknown>> = []
    let failPreview = false
    let empty = false
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort()
      if (!url.pathname.startsWith('/api/trpc/')) return route.continue()
      const raw = url.searchParams.get('input') ?? route.request().postData() ?? '{}'
      const inputs = JSON.parse(raw) as Record<string, { json?: Record<string, unknown> }>
      const methods = url.pathname.split('/').at(-1)!.split(',')
      const results = methods.map((method, index) => {
        const input = inputs[String(index)]?.json ?? {}
        if (method === 'admin.listKnowledgeProposalTemporalEvidence') {
          return {
            result: {
              data: {
                json: {
                  items: empty ? [] : [sourceItem],
                  nextCursor: null,
                  requiresTemporalEvidence: true,
                },
              },
            },
          }
        }
        if (method === 'admin.previewSemanticVenueUpdate') {
          previewInputs.push(input)
          if (failPreview)
            return {
              error: {
                json: {
                  message: expiryMessage,
                  code: -32012,
                  data: { code: 'PRECONDITION_FAILED', httpStatus: 412, path: method },
                },
              },
            }
          return {
            result: {
              data: {
                json: {
                  classification: 'TEMPORAL',
                  operationCount: 1,
                  authority: 'UNVERIFIED',
                  confidence: 0,
                  blockers: [],
                  questions: [],
                  proposalStatus: 'APPROVED',
                  previewHash: 'a'.repeat(64),
                  conflictQuestion: null,
                  questionAgentIdentities: [],
                  autoPublish: false,
                  temporalEvidence: {
                    reference,
                    claimHash: 'b'.repeat(64),
                    authorityBasis: 'REVIEW_ASSERTED',
                    authorityVerified: false,
                  },
                  operationalUpdateDraft: {
                    status: 'DRAFT',
                    updateType: 'TEMPORARY_CLOSURE',
                    severity: 'INFO',
                    priority: 'NORMAL',
                    title: desired.title,
                    body: desired.content,
                    startsAt: dates.validFrom,
                    expiresAt: dates.validUntil,
                    autoSchedule: false,
                    autoPublish: false,
                  },
                },
              },
            },
          }
        }
        if (method === 'admin.createSemanticOperationalUpdateDraft') {
          draftInputs.push(input)
          return {
            result: {
              data: {
                json: {
                  operationalUpdateId: 'fixture-operational-draft',
                  operationalUpdateStatus: 'DRAFT',
                  replayed: false,
                  previewHash: 'a'.repeat(64),
                  classification: 'TEMPORAL',
                  autoScheduled: false,
                  autoPublished: false,
                },
              },
            },
          }
        }
        throw new Error(`Unexpected fixture API call: ${method}`)
      })
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(results) })
    })
    await page.goto('/dev-fixtures/semantic-temporal-evidence')
    await expect(page.getByRole('heading', { name: 'Dated source handoff' })).toBeVisible()
    await page.getByRole('button', { name: 'Build semantic change preview' }).click()
    await page.getByLabel('Time-bounded operational fact').check()
    await expect(page.getByLabel('Enabled in canonical knowledge')).toHaveCount(0)
    const choose = page.getByRole('button', { name: 'Use reviewed source', exact: true })
    await expect(choose).toBeVisible()
    expect(draftInputs).toHaveLength(0)
    // Real keyboard activation, not a synthetic click assertion.
    await choose.focus()
    await expect(choose).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Reviewed source selected' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByLabel('Visitor-facing title')).toHaveValue(desired.title)
    await expect
      .poll(async () =>
        page
          .getByLabel('Starts at')
          .evaluate((node) => new Date((node as HTMLInputElement).value).toISOString()),
      )
      .toBe(dates.validFrom)
    await page.getByLabel('Operational update type').selectOption('TEMPORARY_CLOSURE')
    const assertViewport = async () => {
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true)
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    }
    await assertViewport()
    await page.screenshot({ path: info.outputPath(`selected-${width}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Compute semantic preview' }).click()
    await expect(page.getByText('TEMPORAL', { exact: true })).toBeVisible()
    expect(previewInputs.at(-1)).toMatchObject({ temporalEvidence: reference, desired, ...dates })
    expect(draftInputs).toHaveLength(0)
    await page.getByRole('button', { name: 'Create operational update DRAFT' }).click()
    await expect(page.getByText(/Created DRAFT/)).toBeVisible()
    expect(draftInputs).toHaveLength(1)
    expect(draftInputs[0]).toMatchObject({ temporalEvidence: reference, ...dates })
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Build semantic change preview' }).click()
    await expect(choose).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('button', { name: 'Compute semantic preview' })).toBeDisabled()
    await choose.click()
    await page
      .getByLabel('Visitor-facing content')
      .fill('A revised statement clears the selection.')
    await expect(choose).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('button', { name: 'Compute semantic preview' })).toBeDisabled()
    await choose.click()
    failPreview = true
    await page.getByRole('button', { name: 'Compute semantic preview' }).click()
    await expect(page.locator('main').getByRole('alert')).toHaveText(expiryMessage)
    await assertViewport()
    await page.screenshot({ path: info.outputPath(`expired-${width}.png`), fullPage: true })
    empty = true
    await page.getByRole('button', { name: 'Refresh sources' }).click()
    await expect(page.locator('main').getByRole('status')).toContainText(/No .*dated sources/)
    await page.screenshot({ path: info.outputPath(`empty-${width}.png`), fullPage: true })
    await expect(page.getByRole('button', { name: 'Compute semantic preview' })).toBeDisabled()
    expect(draftInputs).toHaveLength(1)
  })
}
