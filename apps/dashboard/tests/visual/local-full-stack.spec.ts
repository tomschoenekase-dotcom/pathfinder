import { expect, test, type Page, type TestInfo } from '@playwright/test'

const webBaseUrl = 'http://127.0.0.1:56345'
const webSameHostBaseUrl = 'http://localhost:56345'
const dashboardBaseUrl = 'http://localhost:56346'
const localFullStackSelected =
  process.env.PLAYWRIGHT_DASHBOARD_BASE_URL === 'http://127.0.0.1:56346' &&
  process.env.PLAYWRIGHT_VISITOR_BASE_URL === 'http://127.0.0.1:56345'
test.skip(!localFullStackSelected, 'Packet 14 journeys require the explicit disposable stack URLs.')
const allowedOrigins = new Set([
  webBaseUrl,
  webSameHostBaseUrl,
  dashboardBaseUrl,
  'http://127.0.0.1:56342',
])
const viewports = [
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const

type StreamEvidence = {
  viewport: string
  turn: number
  firstVisibleWordsMs: number
  providerFirstTextMs: number
  requestFirstTextMs: number
  answerWordCount: number
  visiblePaintWordCounts: number[]
  ndjsonEventTypes: string[]
}

type StreamEvent = {
  type?: string
  delta?: string
  providerFirstTextMs?: number
  requestFirstTextMs?: number
}

type PaintSamples = {
  active: boolean
  wordCounts: number[]
  lastWordCount: number
}

type StreamWindow = Window & { __packet14StreamBodies?: string[] }

async function captureBrowserStreamBodies(page: Page) {
  await page.addInitScript(() => {
    const streamWindow = window as StreamWindow
    const bodies: string[] = []
    streamWindow.__packet14StreamBodies = bodies
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (...arguments_: Parameters<typeof fetch>) => {
      const response = await originalFetch(...arguments_)
      const input = arguments_[0]
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString()
      if (new URL(url, location.href).pathname === '/api/chat-stream' && response.body) {
        const index = bodies.push('') - 1
        const decoder = new TextDecoder()
        const recordedBody = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bodies[index] += decoder.decode(chunk, { stream: true })
              controller.enqueue(chunk)
            },
            flush() {
              bodies[index] += decoder.decode()
            },
          }),
        )
        return new Response(recordedBody, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      return response
    }
  })
}

async function blockExternalRequests(page: Page) {
  const externalRequests: string[] = []
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue()
    const origin = `${url.protocol}//${url.host}`
    if (allowedOrigins.has(origin)) return route.continue()
    externalRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`)
    return route.abort('blockedbyclient')
  })
  return externalRequests
}

async function signInAs(page: Page, identityLabel: string) {
  await page.goto(`${dashboardBaseUrl}/sign-in`)
  await page.locator('select[name="identity"]').selectOption({ label: identityLabel })
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(
    identityLabel === 'Platform admin' ? `${dashboardBaseUrl}/admin` : `${dashboardBaseUrl}/`,
  )
}

async function signOut(page: Page) {
  const openNavigation = page.getByRole('button', { name: 'Open navigation' })
  if (await openNavigation.isVisible().catch(() => false)) await openNavigation.click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/sign-in(?:\?|$)/u)
}

async function expectGuestWebProtectedQueryDenied(page: Page, venueId: string) {
  // Browser cookies are host-scoped, so this dashboard cookie is available to the
  // same context on web port 56345. The public web app must still treat it as guest.
  const webCookies = await page.context().cookies(webSameHostBaseUrl)
  expect(webCookies.some((cookie) => cookie.name === 'torchiko_local_fixture')).toBe(true)

  const input = encodeURIComponent(JSON.stringify({ json: { id: venueId } }))
  const response = await page
    .context()
    .request.get(`${webSameHostBaseUrl}/api/trpc/venue.getById?input=${input}`)
  expect(response.status()).toBe(401)
  expect(await response.text()).toMatch(/UNAUTHORIZED/u)
}

async function openVisitorExperience(page: Page) {
  await page.goto(`${dashboardBaseUrl}/look-and-feel`)
  await expect(page.getByRole('heading', { name: 'Look & feel' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible()
}

async function captureFirstVisibleWords(
  page: Page,
  priorAssistantCount: number,
  startedAt: number,
): Promise<number> {
  await page.waitForFunction(
    ({ priorAssistantCount }) => {
      const messages = [...document.querySelectorAll<HTMLElement>('[data-role="assistant"]')]
      const latest = messages.at(-1)
      return (
        messages.length > priorAssistantCount &&
        (latest?.innerText.trim().split(/\s+/u).filter(Boolean).length ?? 0) >= 2
      )
    },
    { priorAssistantCount },
  )
  const now = await page.evaluate(() => performance.now())
  return Math.round((now - startedAt) * 10) / 10
}

async function sendAndCaptureTurn(
  page: Page,
  testInfo: TestInfo,
  viewportName: string,
  turn: number,
  message: string,
): Promise<StreamEvidence> {
  const assistantMessages = page.locator('[data-role="assistant"]')
  const priorAssistantCount = await assistantMessages.count()
  await page.evaluate((targetIndex) => {
    const paintWindow = window as typeof window & { __packet14PaintSamples?: PaintSamples }
    const samples: PaintSamples = { active: true, wordCounts: [], lastWordCount: 0 }
    paintWindow.__packet14PaintSamples = samples
    const sampleFrame = () => {
      if (!samples.active) return
      const assistant =
        document.querySelectorAll<HTMLElement>('[data-role="assistant"]')[targetIndex]
      const text = assistant?.innerText.trim() ?? ''
      const wordCount = text ? text.split(/\s+/u).length : 0
      if (wordCount > samples.lastWordCount) {
        samples.lastWordCount = wordCount
        samples.wordCounts.push(wordCount)
      }
      requestAnimationFrame(sampleFrame)
    }
    requestAnimationFrame(sampleFrame)
  }, priorAssistantCount)
  const streamResponsePromise = page.waitForResponse((response) => {
    const request = response.request()
    return new URL(response.url()).pathname === '/api/chat-stream' && request.method() === 'POST'
  })

  await page.getByRole('textbox', { name: 'Ask a question', exact: true }).fill(message)
  const startedAt = await page.evaluate(() => performance.now())
  await page.getByRole('button', { name: 'Send message' }).click()
  const firstVisibleWordsMs = await captureFirstVisibleWords(page, priorAssistantCount, startedAt)

  const response = await streamResponsePromise
  expect(response.ok(), `chat stream turn ${turn} should succeed`).toBe(true)
  expect(response.headers()['content-type']).toMatch(/^application\/x-ndjson\b/iu)
  expect(response.headers()['cache-control']).toContain('no-store')

  await page.waitForFunction((index) => {
    const body = (window as StreamWindow).__packet14StreamBodies?.[index]
    return typeof body === 'string' && body.includes('"type":"complete"')
  }, turn - 1)
  const capturedBody = await page.evaluate(
    (index) => (window as StreamWindow).__packet14StreamBodies?.[index] ?? '',
    turn - 1,
  )
  const lines = capturedBody.split(/\r?\n/u).filter(Boolean)
  const events = lines.map((line) => JSON.parse(line) as StreamEvent)
  const deltaEvents = events.filter((event) => event.type === 'delta')
  expect(deltaEvents.length).toBeGreaterThan(0)
  expect(events.at(-1)?.type).toBe('complete')

  const finalAnswer = (await assistantMessages.last().innerText()).trim()
  expect(finalAnswer).toMatch(/\S/u)
  const answerWordCount = finalAnswer.split(/\s+/u).length
  const visiblePaintWordCounts = await page.evaluate(() => {
    const paintWindow = window as typeof window & { __packet14PaintSamples?: PaintSamples }
    const samples = paintWindow.__packet14PaintSamples
    if (!samples) return []
    samples.active = false
    return samples.wordCounts
  })
  const firstDelta = deltaEvents[0]
  if (!firstDelta) throw new Error(`Chat stream turn ${turn} did not contain a delta event`)
  const { providerFirstTextMs, requestFirstTextMs } = firstDelta
  if (typeof providerFirstTextMs !== 'number' || typeof requestFirstTextMs !== 'number') {
    throw new Error(`Chat stream turn ${turn} did not include first-text timing metadata`)
  }
  await testInfo.attach(`${viewportName}-turn-${turn}-ndjson-timing`, {
    body: JSON.stringify({
      viewport: viewportName,
      turn,
      firstVisibleWordsMs,
      providerFirstTextMs,
      requestFirstTextMs,
      answerWordCount,
      visiblePaintWordCounts,
      ndjsonEventTypes: events.map((event) => event.type ?? 'unknown'),
    } satisfies StreamEvidence),
    contentType: 'application/json',
  })
  expect(answerWordCount).toBeGreaterThan(40)
  expect(visiblePaintWordCounts.length).toBeGreaterThanOrEqual(3)

  return {
    viewport: viewportName,
    turn,
    firstVisibleWordsMs,
    providerFirstTextMs,
    requestFirstTextMs,
    answerWordCount,
    visiblePaintWordCounts,
    ndjsonEventTypes: events.map((event) => event.type ?? 'unknown'),
  }
}

test('visitor guide completes two NDJSON streamed turns and records first visible words at phone and desktop widths', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000)
  test.skip(
    testInfo.project.name !== 'phone-390x844',
    'This test explicitly covers both viewport widths.',
  )
  const externalRequests = await blockExternalRequests(page)
  await captureBrowserStreamBodies(page)
  const evidence: StreamEvidence[] = []

  for (const viewport of viewports) {
    if (viewport.name === 'desktop-1440') await page.evaluate(() => sessionStorage.clear())
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto(`${webBaseUrl}/aurora-science-museum/chat`)
    const log = page.getByRole('log')
    await expect(log).toBeVisible()
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Ask a question', exact: true })).toBeVisible()

    evidence.push(
      await sendAndCaptureTurn(
        page,
        testInfo,
        viewport.name,
        1,
        'What can families explore at this museum?',
      ),
    )
    evidence.push(
      await sendAndCaptureTurn(
        page,
        testInfo,
        viewport.name,
        2,
        'Which exhibit should we start with?',
      ),
    )
    await page.screenshot({
      path: testInfo.outputPath(`local-full-stack-visitor-${viewport.name}.png`),
      fullPage: true,
    })
  }

  expect(evidence).toHaveLength(4)
  expect(externalRequests).toEqual([])
})

test('tenant A saves visitor look and feel, previews it, then signs out at phone and desktop widths', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000)
  test.skip(
    testInfo.project.name !== 'phone-390x844',
    'This test explicitly covers both viewport widths.',
  )
  const externalRequests = await blockExternalRequests(page)

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await signInAs(page, 'Tenant A owner')
    await expect(page.getByRole('heading', { name: 'Tenant A' })).toBeVisible()
    await openVisitorExperience(page)
    await expect(page.getByLabel('Venue', { exact: true })).toHaveValue('cpacket14aurora0000000000')
    await page.getByRole('radio', { name: 'Both in bubbles' }).check()
    await page
      .getByRole('group', { name: 'Visitor messages' })
      .getByLabel('Custom bubble colour')
      .fill('#2d6a4f')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('status')).toContainText(/Saved\./u)
    await page.reload()
    await expect(
      page.getByRole('group', { name: 'Visitor messages' }).getByLabel('Custom bubble colour'),
    ).toHaveValue('#2d6a4f')
    if (viewport.width < 1024) {
      await page
        .getByRole('group', { name: 'Look & feel view' })
        .getByRole('button', { name: 'Preview' })
        .click()
    }
    const preview = page.getByTitle('Preview of the Aurora Science Museum visitor guide')
    await expect(preview).toBeVisible()
    await expect(page.getByText('Sample conversation, showing your saved design.')).toBeVisible()

    await page.screenshot({
      path: testInfo.outputPath(`local-full-stack-client-${viewport.name}.png`),
      fullPage: true,
    })
    await signOut(page)
    expect(externalRequests).toEqual([])
  }
})

test('tenant B cannot read a tenant A venue through the client portal or its protected venue query', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000)
  test.skip(
    testInfo.project.name !== 'phone-390x844',
    'This test explicitly covers both viewport widths.',
  )
  const externalRequests = await blockExternalRequests(page)

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await signInAs(page, 'Tenant A owner')
    await expect(page.getByRole('heading', { name: 'Tenant A' })).toBeVisible()
    await openVisitorExperience(page)
    const venueSelect = page.getByLabel('Venue', { exact: true })
    const tenantAVenueOption = venueSelect.getByRole('option', {
      name: 'Aurora Science Museum',
      exact: true,
    })
    const tenantAVenueId = await tenantAVenueOption.getAttribute('value')
    expect(tenantAVenueId).toBe('cpacket14aurora0000000000')
    if (!tenantAVenueId) throw new Error('Seeded tenant A venue is missing its identifier')
    await expectGuestWebProtectedQueryDenied(page, tenantAVenueId)
    await signOut(page)

    await signInAs(page, 'Tenant B owner')
    await expect(page.getByRole('heading', { name: 'Tenant B' })).toBeVisible()
    await page.goto(`${dashboardBaseUrl}/look-and-feel`)
    await expect(page.getByRole('heading', { name: 'Look & feel' })).toBeVisible({
      timeout: 30_000,
    })
    const tenantBVenueSelect = page.getByLabel('Venue', { exact: true })
    expect(
      await tenantBVenueSelect.locator('option').evaluateAll((options) =>
        options.map((option) => ({
          name: option.textContent?.trim(),
          id: option.getAttribute('value'),
        })),
      ),
    ).toEqual([{ name: 'Riverbend Nature Centre', id: 'cpacket14riverbend0000000' }])
    await expect(
      tenantBVenueSelect.getByRole('option', { name: 'Riverbend Nature Centre', exact: true }),
    ).toBeAttached()
    await expect(
      tenantBVenueSelect.getByRole('option', { name: 'Aurora Science Museum', exact: true }),
    ).toHaveCount(0)
    await expect(
      tenantBVenueSelect.getByRole('option', { name: 'Pocket Collection Museum', exact: true }),
    ).toHaveCount(0)

    const input = encodeURIComponent(JSON.stringify({ json: { id: tenantAVenueId } }))
    const denied = await page.request.get(
      `${dashboardBaseUrl}/api/trpc/venue.getById?input=${input}`,
    )
    expect(denied.status()).toBe(404)
    const denialBody = await denied.text()
    expect(denialBody).toMatch(/NOT_FOUND|Venue not found/u)
    expect(denialBody).not.toContain('Aurora Science Museum')
    await page.screenshot({
      path: testInfo.outputPath(`local-full-stack-tenant-b-${viewport.name}.png`),
      fullPage: true,
    })
    await signOut(page)
    expect(externalRequests).toEqual([])
  }
})

test('tenant A sends a harmless file through the R2 portal Home review flow', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000)
  test.skip(
    testInfo.project.name !== 'phone-390x844',
    'This test explicitly covers both viewport widths.',
  )
  const externalRequests = await blockExternalRequests(page)

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await signInAs(page, 'Tenant A owner')
    const information = page.getByRole('region', { name: 'Send us information' })
    await expect(information).toBeVisible()
    const fileName = `packet14-invented-venue-notes-${viewport.name}.txt`
    await information.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from('Invented local fixture: the museum has a new family activity.\n'),
    })
    await expect(information.getByText(fileName)).toBeVisible()
    await information.getByRole('button', { name: 'Send to Torchiko', exact: true }).click()
    await expect(information.getByText(/Sent to Torchiko|finishing safety check/u)).toBeVisible({
      timeout: 90_000,
    })
    await expect(information.getByRole('link', { name: 'See what you’ve sent' })).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath(`local-full-stack-portal-upload-${viewport.name}.png`),
      fullPage: true,
    })
    await signOut(page)
    expect(externalRequests).toEqual([])
  }
})
