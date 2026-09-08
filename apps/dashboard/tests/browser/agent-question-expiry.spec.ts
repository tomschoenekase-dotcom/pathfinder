import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Request } from '@playwright/test'

const scope = {
  tenantId: 'fixture-history-tenant',
  venueId: 'fixture-history-venue',
  questionId: 'fixture-expired-linked-question',
}

const cutoff = new Date('2026-09-08T16:02:00.000Z')

const viewports = [
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'tablet-820', width: 820, height: 1180 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const

function trpcResult(data: unknown) {
  return JSON.stringify([{ result: { data: { json: data } } }])
}

function requestInput(request: Request) {
  const raw = new URL(request.url()).searchParams.get('input') ?? request.postData() ?? '{}'
  const envelope = JSON.parse(raw) as Record<string, { json?: unknown }>
  return envelope['0']?.json ?? envelope['0'] ?? envelope
}

test('keeps expired question review and recovery paths visible while a pending form removes controls at its cutoff', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.context().route('**/api/trpc/admin.listAgentQuestionDiscussion**', async (route) => {
    expect(requestInput(route.request())).toMatchObject({ ...scope, limit: 20 })
    await route.fulfill({
      contentType: 'application/json',
      body: trpcResult({
        items: [
          {
            id: 'fixture-expired-note',
            authorId: 'fixture-operator',
            body: 'The expired question remains reviewable with its recorded operator context.',
            createdAt: '2026-09-08T16:00:00.000Z',
          },
        ],
        nextCursor: null,
      }),
    })
  })
  await page.clock.install({ time: new Date('2026-09-08T16:00:00.000Z') })
  await page.goto('/dev-fixtures/agent-question-history?surface=expiry')

  const inbox = page.locator('#inbox')
  const linkedExpired = inbox.locator('article').filter({
    hasText: 'Confirm the reviewed arrival route before the response window closes.',
  })
  const runlessExpired = inbox.locator('article').filter({
    hasText: 'Record a replacement task if the unresolved visitor detail still needs work.',
  })
  await expect(linkedExpired.getByText('Response window closed', { exact: true })).toBeVisible()
  await expect(
    linkedExpired.getByText(
      'Review the linked run. If it is still blocked, cancel it before starting a replacement task.',
      { exact: true },
    ),
  ).toBeVisible()
  await expect(linkedExpired.getByRole('link', { name: 'Open linked run' })).toHaveAttribute(
    'href',
    '/admin/clients/fixture-history-tenant/venues/fixture-history-venue/agents/runs/fixture-expired-run',
  )
  await expect(runlessExpired.getByRole('link', { name: 'Start a new task' })).toHaveAttribute(
    'href',
    '/admin/clients/fixture-history-tenant/venues/fixture-history-venue/agents#new-task',
  )
  await expect(linkedExpired.getByRole('button', { name: 'Answer agent' })).toHaveCount(0)
  await linkedExpired.getByText('Question discussion', { exact: true }).press('Enter')
  await expect(
    linkedExpired.getByText(
      'The expired question remains reviewable with its recorded operator context.',
      { exact: true },
    ),
  ).toBeVisible()

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
    expect((await new AxeBuilder({ page }).include('#inbox').analyze()).violations).toEqual([])
    await inbox.screenshot({
      path: testInfo.outputPath(`agent-question-expiry-${viewport.name}.png`),
    })
  }

  await page.goto('/dev-fixtures/agent-question-history?surface=timer')
  const pending = page.locator('#inbox article').filter({
    hasText: 'Confirm whether the north entrance remains available for the morning arrival.',
  })
  await expect(pending.getByRole('button', { name: 'Answer agent' })).toBeVisible()
  await expect(pending.getByText('Response window closes', { exact: false })).toBeVisible()
  await page.clock.fastForward(
    cutoff.getTime() - new Date('2026-09-08T16:00:00.000Z').getTime() + 1,
  )
  await expect(pending.getByText('Response window closed', { exact: true })).toBeVisible()
  await expect(pending.getByRole('button', { name: 'Answer agent' })).toHaveCount(0)
  await expect(pending.getByLabel('Your answer')).toHaveCount(0)
  await expect(pending.getByRole('link', { name: 'Open linked run' })).toHaveAttribute(
    'href',
    '/admin/clients/fixture-history-tenant/venues/fixture-history-venue/agents/runs/fixture-pending-run',
  )
  expect(pageErrors).toEqual([])
})
