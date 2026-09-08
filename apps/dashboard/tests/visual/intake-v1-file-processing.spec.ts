import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

function receipt() {
  return {
    id: 'v1-file-processing-submission',
    status: 'AWAITING_CANONICAL_REVIEW',
    revision: 1,
    revisions: [
      {
        revision: 1,
        criticalMissing: [],
        members: [
          {
            kind: 'INTAKE_UPLOAD',
            intakeRunId: null,
            intakeUploadId: 'fixture-file-disabled',
            linkedIntakeRunId: null,
            displayName: 'Visitor guide.pdf',
            sourceKind: 'FILE_UPLOAD',
          },
          {
            kind: 'INTAKE_UPLOAD',
            intakeRunId: null,
            intakeUploadId: 'fixture-file-ready',
            linkedIntakeRunId: null,
            displayName: 'Public hours.txt',
            sourceKind: 'FILE_UPLOAD',
          },
        ],
      },
    ],
  }
}

async function hideFrameworkDevChrome(page: Page) {
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  const keylessPrompt = page.getByRole('button', { name: 'Keyless prompt' })
  await keylessPrompt
    .first()
    .waitFor({ state: 'attached', timeout: 2_000 })
    .catch(() => undefined)
  await keylessPrompt.evaluateAll((buttons) => {
    for (const button of buttons) {
      let current: Element | null = button
      while (current?.parentElement && current.parentElement !== document.body) {
        if (window.getComputedStyle(current).position === 'fixed') {
          current.remove()
          current = null
          break
        }
        current = current.parentElement
      }
      current?.remove()
    }
  })
}

async function expectViewportIntegrity(page: Page) {
  await expect
    .poll(() => page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1))
    .toBe(true)
}

async function expectAccessiblePage(page: Page) {
  const result = await new AxeBuilder({ page }).include('body').analyze()
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([])
}

async function saveViewportEvidence(page: Page, testInfo: TestInfo) {
  const screenshot = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath('intake-v1-file-processing.png'),
  })
  expect(screenshot.byteLength).toBeGreaterThan(10_000)
}

test('V1 receipt distinguishes disabled file work from completed file preparation', async ({
  page,
}, testInfo) => {
  const runtimeErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`))

  await page.route('**/api/trpc/**', async (route) => {
    const url = new URL(route.request().url())
    const procedures = decodeURIComponent(url.pathname.split('/api/trpc/')[1]!).split(',')
    const results = procedures.map((procedure) => {
      if (procedure === 'intake.getSubmissionDraft') return { result: { data: { json: null } } }
      if (procedure === 'intake.getLatestV1') return { result: { data: { json: receipt() } } }
      if (procedure === 'intake.getV1Processing') {
        return {
          result: {
            data: {
              json: {
                submissionId: 'v1-file-processing-submission',
                revision: 1,
                members: [
                  {
                    memberId: 'fixture-file-disabled',
                    ordinal: 0,
                    displayName: 'Visitor guide.pdf',
                    sourceLabel: 'Uploaded file',
                    processingKind: 'FILE_EXTRACTION',
                    status: 'POLICY_DISABLED',
                    reasonCode: 'FILE_EXTRACTION_DISABLED',
                  },
                  {
                    memberId: 'fixture-file-ready',
                    ordinal: 1,
                    displayName: 'Public hours.txt',
                    sourceLabel: 'Uploaded file',
                    processingKind: 'FILE_EXTRACTION',
                    status: 'COMPLETED',
                    reasonCode: null,
                  },
                ],
              },
            },
          },
        }
      }
      throw new Error(`Unexpected fixture procedure: ${procedure}`)
    })
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(url.searchParams.get('batch') === '1' ? results : results[0]),
    })
  })

  await page.goto(`${dashboardBaseUrl}/dev-fixtures/remote-onboarding?state=share&v1=1`)
  await hideFrameworkDevChrome(page)

  const processing = page.getByRole('region', { name: 'Material processing' })
  await expect(processing).toBeVisible()
  await expect(processing.getByText('Visitor guide.pdf', { exact: true })).toBeVisible()
  await expect(processing.getByText('Public hours.txt', { exact: true })).toBeVisible()
  await expect(processing.getByText('Waiting for file processing to be enabled')).toBeVisible()
  await expect(processing.getByText('Ready for review', { exact: true })).toBeVisible()
  await expect(processing.getByText('Waiting for research to be enabled')).toHaveCount(0)

  const refresh = processing.getByRole('button', { name: 'Refresh status' })
  await refresh.focus()
  await expect(refresh).toBeFocused()
  await refresh.press('Enter')
  await expect(refresh).toBeEnabled()
  await processing.scrollIntoViewIfNeeded()
  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveViewportEvidence(page, testInfo)
  expect(runtimeErrors).toEqual([])
})
