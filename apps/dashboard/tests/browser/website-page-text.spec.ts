import AxeBuilder from '@axe-core/playwright'
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test'

const receiptId = '968c2e1a-8ece-47ad-98dc-e4bde64872ca'
const first = {
  sourceUrl: 'https://greenhouse.example/very/long/visitor-information-and-private-event-details',
  exactByteHash: 'a'.repeat(64),
  capturedAt: '2026-09-08T12:00:00.000Z',
  extractionProfile: 'pdfjs-document-v1',
  pdfPageCount: 17,
  normalizedTextHash: 'b'.repeat(64),
  retainedTextHash: 'c'.repeat(64),
  fullCodePointCount: 5600,
  retainedCodePointCount: 4000,
  truncated: true,
}
const second = {
  ...first,
  sourceUrl: 'https://greenhouse.example/contact',
  exactByteHash: 'd'.repeat(64),
  retainedTextHash: 'e'.repeat(64),
  fullCodePointCount: 118,
  retainedCodePointCount: 118,
  truncated: false,
  extractionProfile: 'plain-text-v1',
  pdfPageCount: undefined,
}
const viewports = [
  { name: 'phone-320', width: 320, height: 700 },
  { name: 'tablet-820', width: 820, height: 1000 },
  { name: 'laptop-1024', width: 1024, height: 800 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const

type Control = { failList: boolean; legacy: boolean; listInputs: unknown[]; readInputs: unknown[] }
function trpcResult(data: unknown) {
  return JSON.stringify([{ result: { data: { json: data } } }])
}
function requestInput(request: Request) {
  const raw = new URL(request.url()).searchParams.get('input') ?? request.postData() ?? '{}'
  const envelope = JSON.parse(raw) as Record<string, { json?: unknown }>
  return envelope['0']?.json ?? envelope['0'] ?? envelope
}
async function installTransport(context: BrowserContext, control: Control) {
  await context.route('**/api/trpc/admin.listWebsitePageText**', async (route) => {
    control.listInputs.push(requestInput(route.request()))
    if (control.failList) {
      control.failList = false
      await route.fulfill({ status: 503, contentType: 'application/json', body: '[]' })
      return
    }
    const result = control.legacy
      ? { status: 'NOT_RECORDED', receiptId, sourceId: 'fixture-source', pages: [] }
      : { status: 'RECORDED', receiptId, sourceId: 'fixture-source', pages: [first, second] }
    await route.fulfill({ contentType: 'application/json', body: trpcResult(result) })
  })
  await context.route('**/api/trpc/admin.readWebsitePageText**', async (route) => {
    const input = requestInput(route.request()) as {
      sourceUrl: string
      cursor?: string
      search?: string
    }
    control.readInputs.push(input)
    const contact = input.sourceUrl === second.sourceUrl
    const continuation = Boolean(input.cursor)
    const text = contact
      ? 'Call <strong>555-0100</strong> & ask for events.'
      : continuation
        ? 'Second segment: Grand Hall remains exact.'
        : `${'Welcome to the greenhouse. '.repeat(18)}\nGrand Hall\ngrand hall\n<script>never rendered</script>`
    await route.fulfill({
      contentType: 'application/json',
      body: trpcResult({
        status: 'RECORDED',
        receiptId,
        ...(contact ? second : first),
        page: {
          offset: continuation ? 2000 : input.search ? 420 : 0,
          limit: 2000,
          text,
          matchOffsets: input.search === 'Grand Hall' ? [text.indexOf('Grand Hall')] : [],
        },
        nextCursor: contact || continuation ? null : 'fixture-cursor',
      }),
    })
  })
}
function pageErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

test('renders, searches, paginates, handles errors, and remains accessible at four widths', async ({
  page,
}, testInfo) => {
  const control: Control = { failList: false, legacy: false, listInputs: [], readInputs: [] }
  await installTransport(page.context(), control)
  const errors = pageErrors(page)

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/dev-fixtures/website-page-text')
    const inventories = page.getByText(/Source inventory/)
    await inventories.nth(0).click()
    await inventories.nth(1).click()
    await expect(page.getByText('PDF text collected')).toBeVisible()
    await expect(page.getByText('Password required')).toBeVisible()
    await expect(page.getByText('Extraction timed out')).toBeVisible()
    await expect(page.getByText('Crawl time limit reached')).toBeVisible()
    await expect(page.getByText(/historical policy did not extract PDF text/i)).toBeVisible()
    await page.getByRole('button', { name: 'Open retained website text' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Read selected page' })).toBeVisible()
    await expect(page.getByText('PDF embedded text · 17 pages')).toBeVisible()
    await page.getByRole('button', { name: 'Read selected page' }).click()
    await expect(page.getByText(/never rendered/)).toBeVisible()
    expect(await page.locator('main script').count()).toBe(0)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
    expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([])
    await page.screenshot({
      path: testInfo.outputPath(`website-page-text-${viewport.name}.png`),
      fullPage: true,
    })
  }

  await page.getByLabel('Find exact text (case-sensitive)').fill('Grand Hall')
  await page.getByRole('button', { name: 'Find and restart' }).click()
  await expect(page.getByText(/1 exact match in this segment/)).toBeVisible()
  await page.getByLabel('Find exact text (case-sensitive)').fill('draft changed')
  await page.getByRole('button', { name: 'Next segment' }).click()
  await expect(page.getByText('Segment 2')).toBeVisible()
  await expect
    .poll(() => control.readInputs.at(-1))
    .toMatchObject({ cursor: 'fixture-cursor', search: 'Grand Hall' })

  control.failList = true
  await page.getByRole('button', { name: 'Reload retained text' }).click()
  await expect(page.getByText(/retained website text could not be loaded/i)).toBeVisible()
  await page.getByRole('button', { name: 'Reload retained text' }).click()
  await expect(page.getByRole('button', { name: 'Read selected page' })).toBeVisible()

  control.legacy = true
  await page.getByRole('button', { name: 'Reload retained text' }).click()
  await expect(page.getByText(/legacy research receipt/i)).toBeVisible()
  expect(errors).toEqual([])
})
