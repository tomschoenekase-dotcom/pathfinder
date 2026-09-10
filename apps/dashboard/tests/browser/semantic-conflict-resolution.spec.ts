import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const desired = {
  title: 'Willow gallery hours',
  category: 'Hours',
  content: 'The Willow gallery closes at 7 PM.',
  isEnabled: true,
}
const question = {
  id: 'question-semantic-conflict',
  agentIdentityId: 'content-specialist',
  status: 'ANSWERED',
  answer: 'Use the signed operations sheet and prepare 6 PM for review.',
  answeredAt: '2026-09-10T12:04:00.000Z',
  updatedAt: '2026-09-10T12:04:00.000Z',
  answerHash: 'b'.repeat(64),
}

for (const width of [390, 768, 1280, 1440]) {
  test(`answered semantic conflict resolution at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width <= 768 ? 1100 : 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const resolutionInputs: Array<Record<string, unknown>> = []
    let resolutionMode: 'success' | 'unknown' | 'conflict' = 'success'
    const heldRequest: { release: (() => void) | null } = { release: null }
    let replacement = true
    let previewReads = 0
    const draftCalls: string[] = []
    const assertViewport = async () => {
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true)
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    }

    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort()
      if (!url.pathname.startsWith('/api/trpc/')) return route.continue()
      const raw = url.searchParams.get('input') ?? route.request().postData() ?? '{}'
      const inputs = JSON.parse(raw) as Record<string, { json?: Record<string, unknown> }>
      const methods = url.pathname.split('/').at(-1)!.split(',')
      const results = []
      for (const [index, method] of methods.entries()) {
        const input = inputs[String(index)]?.json ?? {}
        if (method === 'admin.previewSemanticVenueUpdate') {
          previewReads += 1
          results.push({
            result: {
              data: {
                json: {
                  classification: 'CONFLICT',
                  operationCount: 0,
                  authority: 'TRUSTED_PARTNER',
                  confidence: 0.9,
                  blockers: [
                    {
                      code: 'LOWER_AUTHORITY_CONFLICT',
                      path: 'evidence',
                      message: 'Operator confirmation is required.',
                    },
                  ],
                  questions: [
                    {
                      owner: 'VENUE_OPERATOR',
                      prompt: 'Which hours should visitors receive?',
                      blockerCodes: ['LOWER_AUTHORITY_CONFLICT'],
                    },
                  ],
                  proposalStatus: 'APPROVED',
                  previewHash: 'a'.repeat(64),
                  venuePackagePatch: null,
                  operationalUpdateDraft: null,
                  temporalEvidence: null,
                  operatorResolutionId: null,
                  conflictQuestion: question,
                  questionAgentIdentities: [],
                  autoPublish: false,
                },
              },
            },
          })
          continue
        }
        if (method === 'admin.resolveSemanticConflict') {
          resolutionInputs.push(input)
          if (resolutionMode === 'unknown') {
            await new Promise<void>((resolve) => {
              heldRequest.release = resolve
            })
            await route.abort('failed')
            return
          }
          if (resolutionMode === 'conflict') {
            results.push({
              error: {
                json: {
                  message: 'Question changed',
                  code: -32009,
                  data: { code: 'CONFLICT', httpStatus: 409, path: method },
                },
              },
            })
          } else {
            results.push({
              result: {
                data: {
                  json: {
                    resolutionId: '22222222-2222-4222-8222-222222222222',
                    replacementProposalId: replacement
                      ? '33333333-3333-4333-8333-333333333333'
                      : null,
                    outcome: replacement ? 'PROPOSE_REPLACEMENT' : 'KEEP_CANONICAL',
                    replayed: false,
                    canonicalKnowledgeChanged: false,
                    approvalGranted: false,
                  },
                },
              },
            })
          }
          continue
        }
        if (method.includes('Draft') || method.includes('publish')) draftCalls.push(method)
        throw new Error(`Unexpected fixture API call: ${method}`)
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(results) })
    })

    const openConflict = async () => {
      await page.goto('/dev-fixtures/semantic-conflict-resolution')
      await page.getByRole('button', { name: 'Build semantic change preview' }).click()
      await page.getByLabel('Visitor-facing title').fill(desired.title)
      await page.getByLabel('Category').fill(desired.category)
      await page.getByLabel('Visitor-facing content').fill(desired.content)
      await page.getByRole('button', { name: 'Compute semantic preview' }).click()
      await expect(page.getByText(question.answer, { exact: true })).toBeVisible()
    }

    await openConflict()
    await expect(page.getByRole('button', { name: 'Record resolution' })).toBeDisabled()
    await page.getByLabel(/Propose replacement/).check()
    await page
      .getByRole('textbox', { name: 'Replacement content', exact: true })
      .fill('The Willow gallery closes at 6 PM.')
    await page
      .getByLabel('Resolution note')
      .fill('Use the signed sheet for a separately reviewed replacement.')
    await assertViewport()
    await page.screenshot({
      path: info.outputPath(`replacement-edited-${width}.png`),
      fullPage: true,
    })
    resolutionMode = 'unknown'
    await page.getByRole('button', { name: 'Record resolution' }).click()
    await expect.poll(() => resolutionInputs.length).toBe(1)
    await expect(page.getByLabel('Visitor-facing content')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Close' })).toBeDisabled()
    heldRequest.release?.()
    await expect(page.getByRole('button', { name: 'Retry exact resolution' })).toBeVisible()
    await assertViewport()
    await page.screenshot({ path: info.outputPath(`unknown-retry-${width}.png`), fullPage: true })
    const frozen = structuredClone(resolutionInputs[0])
    resolutionMode = 'success'
    const retry = page.getByRole('button', { name: 'Retry exact resolution' })
    await retry.focus()
    await expect(retry).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByText('Replacement awaits review')).toBeVisible()
    expect(resolutionInputs[1]).toEqual(frozen)
    await expect(page.getByRole('link', { name: 'Review replacement proposal' })).toHaveAttribute(
      'href',
      '/admin/clients/fixture-conflict-tenant/venues/fixture-conflict-venue/knowledge-proposals?review=33333333-3333-4333-8333-333333333333#proposal-33333333-3333-4333-8333-333333333333',
    )
    expect(draftCalls).toEqual([])

    replacement = false
    await openConflict()
    await page.getByLabel(/Keep current guidance/).check()
    await page.getByLabel('Resolution note').fill('Keep the current reviewed venue guidance.')
    await page.getByRole('button', { name: 'Record resolution' }).click()
    await expect(page.getByText('Current knowledge kept')).toBeVisible()
    expect(resolutionInputs.at(-1)).toMatchObject({ outcome: 'KEEP_CANONICAL' })

    await openConflict()
    await page.getByLabel(/Keep current guidance/).check()
    await page.getByLabel('Resolution note').fill('Refresh if the exact answered evidence changed.')
    resolutionMode = 'conflict'
    await page.getByRole('button', { name: 'Record resolution' }).click()
    await expect(page.getByRole('button', { name: 'Refresh conflict' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close' })).toBeDisabled()
    const beforeRefresh = previewReads
    resolutionMode = 'success'
    await page.getByRole('button', { name: 'Refresh conflict' }).click()
    await expect.poll(() => previewReads).toBeGreaterThan(beforeRefresh)
    await expect(page.getByRole('button', { name: 'Close' })).toBeEnabled()
    await expect(page.getByLabel(/Keep current guidance/)).not.toBeChecked()
    await expect(page.getByLabel(/Propose replacement/)).not.toBeChecked()

    expect(draftCalls).toEqual([])
    await assertViewport()
    await page.screenshot({
      path: info.outputPath(`semantic-conflict-${width}.png`),
      fullPage: true,
    })
  })
}
