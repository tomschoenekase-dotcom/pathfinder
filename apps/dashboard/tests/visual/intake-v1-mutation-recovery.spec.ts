import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const base = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'
for (const amendment of [false, true]) {
  test(`V1 ${amendment ? 'amendment' : 'submission'} recovers a transport that never returns`, async ({
    page,
  }, testInfo) => {
    const writes: unknown[] = []
    const revision = amendment ? 2 : 1
    let saved = false
    const member = {
      kind: 'INTAKE_RUN',
      intakeRunId: 'v1-source',
      intakeUploadId: null,
      linkedIntakeRunId: null,
      displayName: 'Visitor access and arrival information',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
    }
    const receipt = (version: number) => ({
      id: 'v1-submission',
      status: 'AWAITING_CANONICAL_REVIEW',
      revision: version,
      revisions: [{ revision: version, criticalMissing: [], members: [member] }],
    })
    let releaseHeld: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve
    })
    await page.route('**/api/trpc/**', async (route) => {
      const url = new URL(route.request().url())
      const procedures = decodeURIComponent(url.pathname.split('/api/trpc/')[1]!).split(',')
      let hold = false
      const results = procedures.map((procedure, index) => {
        let json: unknown
        if (procedure === 'intake.getSubmissionDraft') json = null
        else if (procedure === 'intake.getLatestV1')
          json = saved ? receipt(revision) : amendment ? receipt(1) : null
        else if (procedure === 'intake.getV1') json = receipt(revision)
        else if (procedure === 'intake.listV1Candidates')
          json = {
            items: [
              {
                id: 'v1-source',
                displayName: member.displayName,
                sourceKind: member.sourceKind,
                status: 'AWAITING_REVIEW',
                createdAt: '2026-09-10T00:00:00Z',
              },
            ],
            nextCursor: null,
          }
        else if (procedure === 'intake.listV1UploadCandidates')
          json = { items: [], nextCursor: null }
        else if (procedure === 'intake.submitV1' || procedure === 'intake.amendV1') {
          expect(procedure).toBe(amendment ? 'intake.amendV1' : 'intake.submitV1')
          writes.push(route.request().postDataJSON()[String(index)].json)
          saved = true
          hold = writes.length === 1
          json = {
            submissionId: 'v1-submission',
            revision,
            criticalMissing: [],
            replayed: writes.length > 1,
          }
        } else if (procedure === 'intake.getV1Processing')
          json = {
            submissionId: 'v1-submission',
            revision: JSON.parse(url.searchParams.get('input')!)[String(index)].json.revision,
            members: [
              {
                memberId: 'member-1',
                ordinal: 0,
                displayName: member.displayName,
                sourceLabel: 'Shared notes',
                processingKind: 'REVIEW_READY',
                status: 'COMPLETED',
                reasonCode: null,
              },
            ],
          }
        else throw new Error(`Unexpected procedure ${procedure}`)
        return { result: { data: { json } } }
      })
      if (hold) await held
      await route
        .fulfill({
          contentType: 'application/json',
          body: JSON.stringify(url.searchParams.get('batch') === '1' ? results : results[0]),
        })
        .catch(() => undefined)
    })
    try {
      await page.goto(`${base}/dev-fixtures/remote-onboarding?state=share&v1=1`)
      await page
        .locator('nextjs-portal')
        .evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
      const prepare = page.getByRole('button', {
        name: amendment ? 'Review an update' : 'Review my materials',
      })
      await expect(prepare).toBeEnabled()
      if (amendment) await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()
      await prepare.click()
      const submit = page.getByRole('button', {
        name: amendment ? 'Submit this update' : 'Submit this version',
      })
      await expect(submit).toBeEnabled()
      await page.clock.install()
      await submit.click()
      await expect.poll(() => writes.length).toBe(1)
      await page.clock.fastForward(15_100)
      const retry = page.getByRole('button', { name: 'Check this submission again' })
      await expect(retry).toBeEnabled()
      await expect(
        page.getByText(
          'The result is uncertain. Check this same submission again before changing it.',
        ),
      ).toBeVisible()
      expect(writes).toHaveLength(1)
      await retry.scrollIntoViewIfNeeded()
      await expect
        .poll(() => page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth + 1))
        .toBe(true)
      const accessibility = await new AxeBuilder({ page }).include('body').analyze()
      expect(
        accessibility.violations.map(({ id, nodes }) => ({
          id,
          nodes: nodes.map(({ target }) => target),
        })),
      ).toEqual([])
      await expect(
        page.getByText(
          'Processing details could not be refreshed. Your saved submission is unchanged.',
        ),
      ).toHaveCount(0)
      await page.getByRole('region', { name: 'Choose what goes into this version.' }).screenshot({
        path: testInfo.outputPath('uncertain-v1.png'),
        animations: 'disabled',
      })
      await retry.focus()
      await retry.press('Enter')
      await expect.poll(() => writes.length).toBe(2)
      expect(writes[1]).toEqual(writes[0])
      if (amendment)
        expect(writes[1]).toMatchObject({
          submissionId: 'v1-submission',
          expectedCurrentRevision: 1,
        })
      await expect(page.getByText(`Version ${revision} received`, { exact: true })).toBeVisible()
      releaseHeld!()
      await expect(page.getByText(`Version ${revision} received`, { exact: true })).toBeVisible()
      expect(writes).toHaveLength(2)
    } finally {
      releaseHeld?.()
    }
  })
}
