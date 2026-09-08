import AxeBuilder from '@axe-core/playwright'
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test'

const scope = {
  tenantId: 'fixture-discussion-tenant',
  venueId: 'fixture-discussion-venue',
  questionId: 'fixture-discussion-question',
}
const currentCursor = { createdAt: '2026-09-08T11:30:00.000Z', id: 'fixture-current-note' }
const longAuthor = `operator-${'north-wing-'.repeat(12)}review`
const longBody = `Review the source before answering: ${'unbroken-context-'.repeat(40)}\nA second line stays readable.`
const initialNote = {
  id: 'fixture-current-note',
  authorId: longAuthor,
  body: longBody,
  createdAt: currentCursor.createdAt,
}
const olderNote = {
  id: 'fixture-older-note',
  authorId: 'operator-older',
  body: 'Older operator context remains available through the stable cursor.',
  createdAt: '2026-09-08T10:30:00.000Z',
}
const viewports = [
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'tablet-820', width: 820, height: 1180 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const

type Note = typeof initialNote
type Store = { notes: Note[]; operations: Map<string, Note>; mutations: unknown[] }
type TransportControl = {
  delayNextList: boolean
  releaseList: (() => void) | null
  failNextList: boolean
  loseNextAcknowledgement: boolean
  listInputs: unknown[]
}

function trpcResult(data: unknown) {
  return JSON.stringify([{ result: { data: { json: data } } }])
}

function requestInput(request: Request) {
  const raw = new URL(request.url()).searchParams.get('input') ?? request.postData() ?? '{}'
  const envelope = JSON.parse(raw) as Record<string, { json?: unknown }>
  return envelope['0']?.json ?? envelope['0'] ?? envelope
}

function noteResponse(store: Store, cursor: unknown) {
  if (cursor) return { items: [olderNote], nextCursor: null }
  return { items: store.notes, nextCursor: store.notes.length > 0 ? currentCursor : null }
}

async function installMockedDiscussionTransport(
  context: BrowserContext,
  store: Store,
  control: TransportControl,
) {
  await context.route('**/api/trpc/admin.listAgentQuestionDiscussion**', async (route) => {
    const input = requestInput(route.request())
    control.listInputs.push(input)
    expect(input).toMatchObject({ ...scope, limit: 20 })
    if (control.delayNextList) {
      control.delayNextList = false
      await new Promise<void>((resolve) => {
        control.releaseList = resolve
      })
    }
    if (control.failNextList) {
      control.failNextList = false
      await route.fulfill({ status: 503, contentType: 'application/json', body: '[]' })
      return
    }
    const cursor = (input as { cursor?: unknown }).cursor
    await route.fulfill({
      contentType: 'application/json',
      body: trpcResult(noteResponse(store, cursor)),
    })
  })
  await context.route('**/api/trpc/admin.appendAgentQuestionDiscussion**', async (route) => {
    const input = requestInput(route.request()) as {
      tenantId: string
      venueId: string
      questionId: string
      operationId: string
      body: string
    }
    expect(input).toMatchObject(scope)
    store.mutations.push(input)
    const existing = store.operations.get(input.operationId)
    const message = existing ?? {
      id: `fixture-note-${input.operationId}`,
      authorId: 'fixture-browser-operator',
      body: input.body,
      createdAt: '2026-09-08T12:00:00.000Z',
    }
    if (!existing) {
      store.operations.set(input.operationId, message)
      store.notes = [message, ...store.notes]
    }
    if (control.loseNextAcknowledgement) {
      control.loseNextAcknowledgement = false
      await route.abort('failed')
      return
    }
    await route.fulfill({
      contentType: 'application/json',
      body: trpcResult({ message, replayed: Boolean(existing) }),
    })
  })
}

function freshControl(): TransportControl {
  return {
    delayNextList: false,
    releaseList: null,
    failNextList: false,
    loseNextAcknowledgement: false,
    listInputs: [],
  }
}

function collectPageErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

test('uses the exact mocked discussion transport and preserves a saved note across reload and context', async ({
  page,
  browser,
}) => {
  const pageErrors = collectPageErrors(page)
  const store: Store = { notes: [], operations: new Map(), mutations: [] }
  const control = freshControl()
  await installMockedDiscussionTransport(page.context(), store, control)
  await page.goto('/dev-fixtures/founder-question-discussion')
  await page.getByText('Question discussion', { exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('No discussion notes yet.')).toBeVisible()

  control.loseNextAcknowledgement = true
  const body = 'Confirm the reviewed visitor map before answering the question.'
  await page.getByLabel('Add an operator note').fill(body)
  await page.getByRole('button', { name: 'Save note' }).click()
  await expect(page.getByRole('button', { name: 'Retry same note' })).toBeVisible()
  await expect(page.getByLabel('Add an operator note')).toBeDisabled()
  const firstPayload = store.mutations[0]
  await page.getByRole('button', { name: 'Retry same note' }).click()
  await expect(
    page.getByText('Note saved. The question and its answer are unchanged.'),
  ).toBeVisible()
  expect(store.mutations).toHaveLength(2)
  expect(store.mutations[1]).toEqual(firstPayload)

  await page.reload()
  await page.getByText('Question discussion', { exact: true }).press('Enter')
  await expect(page.getByText(body)).toBeVisible()

  const secondContext = await browser.newContext({ viewport: { width: 820, height: 1180 } })
  const secondControl = freshControl()
  await installMockedDiscussionTransport(secondContext, store, secondControl)
  const secondPage = await secondContext.newPage()
  const secondPageErrors = collectPageErrors(secondPage)
  await secondPage.goto('http://127.0.0.1:3001/dev-fixtures/founder-question-discussion')
  await secondPage.getByText('Question discussion', { exact: true }).press('Enter')
  await expect(secondPage.getByText(body)).toBeVisible()
  await secondContext.close()
  expect(pageErrors).toEqual([])
  expect(secondPageErrors).toEqual([])
})

test('renders mocked loading, error, cursor, and long notes without overflow at each viewport', async ({
  page,
}, testInfo) => {
  const pageErrors = collectPageErrors(page)
  const store: Store = { notes: [initialNote], operations: new Map(), mutations: [] }
  const control = freshControl()
  await installMockedDiscussionTransport(page.context(), store, control)

  for (const viewport of viewports) {
    control.delayNextList = true
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/dev-fixtures/founder-question-discussion')
    await page.getByText('Question discussion', { exact: true }).press('Enter')
    await expect(page.getByRole('status').filter({ hasText: 'Loading notes…' })).toBeVisible()
    control.releaseList?.()
    await expect(page.getByText(longBody)).toBeVisible()
    await expect(page.getByText(`Operator ${longAuthor}`, { exact: false })).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
    expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([])
    await page.screenshot({
      path: testInfo.outputPath(`founder-question-discussion-${viewport.name}.png`),
      fullPage: true,
    })
  }

  control.failNextList = true
  await page.getByRole('button', { name: 'Refresh notes' }).click()
  await expect(
    page.getByText('Notes could not be loaded. Use Refresh notes to try again.', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Refresh notes' }).click()
  await expect(page.getByText(longBody)).toBeVisible()
  await page.getByRole('button', { name: 'Load older notes' }).click()
  await expect(page.getByText(olderNote.body)).toBeVisible()
  expect(control.listInputs.at(-1)).toEqual({ ...scope, limit: 20, cursor: currentCursor })
  expect(pageErrors).toEqual([])
})
