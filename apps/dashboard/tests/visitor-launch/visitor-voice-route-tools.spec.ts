import { expect, test, type Page } from '@playwright/test'

const fixtureUrl = '/dev-fixtures/voice-route-tools'

async function installLocalBrowserSeams(page: Page) {
  await page.addInitScript(() => {
    const sent: string[] = []
    let getUserMediaCalls = 0
    let channel: {
      readyState: string
      send: (value: string) => void
      dispatchMessage: (value: string) => void
    } | null = null
    const track = { addEventListener: () => undefined, stop: () => undefined, readyState: 'live' }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          getUserMediaCalls += 1
          return { getTracks: () => [track] }
        },
      },
    })
    class LocalDataChannel extends EventTarget {
      readyState = 'open'
      close() {
        this.readyState = 'closed'
      }
      send(value: string) {
        sent.push(value)
      }
      dispatchMessage(value: string) {
        this.dispatchEvent(new MessageEvent('message', { data: value }))
      }
    }
    class LocalPeerConnection extends EventTarget {
      connectionState = 'connected'
      iceConnectionState = 'connected'
      onconnectionstatechange: (() => void) | null = null
      oniceconnectionstatechange: (() => void) | null = null
      ontrack: ((event: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null
      private dataChannel = new LocalDataChannel()
      addTrack() {}
      createDataChannel() {
        channel = this.dataChannel
        return this.dataChannel
      }
      async createOffer() {
        return { type: 'offer', sdp: 'v=0\r\n' }
      }
      async setLocalDescription() {}
      async setRemoteDescription() {
        queueMicrotask(() => this.dataChannel.dispatchEvent(new Event('open')))
      }
      close() {
        this.dataChannel.readyState = 'closed'
      }
    }
    Object.assign(window, {
      RTCPeerConnection: LocalPeerConnection,
      __voiceRouteSent: () => [...sent],
      __voiceRouteGetUserMediaCalls: () => getUserMediaCalls,
      __voiceRouteEmit: (event: unknown) => channel?.dispatchMessage(JSON.stringify(event)),
    })
  })
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function trpcPayload(procedure: string): unknown {
  const values: Record<string, unknown> = {
    'voice.availability': { enabled: true, premiumAvailable: false },
    'voice.start': {
      voiceSessionId: '22222222-2222-4222-8222-222222222222',
      clientSecret: 'fixture-client-secret',
      maxDurationSeconds: 120,
    },
    'voice.connected': { ok: true },
    'voice.end': { ok: true },
    'voice.usage': { ok: true },
    'voice.groundingContext': {
      context: '[Lake gallery]\nThe reviewed route begins at the main entrance.',
      sourceIds: ['fixture-route-source'],
      visitContext: null,
    },
    'location.catalog': {
      locations: [
        {
          id: 'fixture-main-entrance',
          stableKey: 'main-entrance',
          kind: 'ENTRANCE',
          displayName: 'Main entrance',
          floor: { stableKey: 'ground', name: 'Ground floor', level: 0 },
        },
        {
          id: 'fixture-lake-gallery',
          stableKey: 'lake-gallery',
          kind: 'EXHIBIT',
          displayName: 'Lake gallery',
          floor: { stableKey: 'upper', name: 'Upper floor', level: 1 },
        },
      ],
    },
    'location.route': {
      from: { id: 'fixture-main-entrance', displayName: 'Main entrance' },
      fromLocation: {
        id: 'fixture-main-entrance',
        stableKey: 'main-entrance',
        kind: 'ENTRANCE',
        displayName: 'Main entrance',
        floor: { stableKey: 'ground', name: 'Ground floor', level: 0 },
      },
      to: {
        id: 'fixture-lake-gallery',
        stableKey: 'lake-gallery',
        kind: 'EXHIBIT',
        displayName: 'Lake gallery',
        floor: { stableKey: 'upper', name: 'Upper floor', level: 1 },
      },
      accessibleOnly: true,
      segmentCount: 2,
      describedSegmentCount: 2,
      guidanceConfidence: 'HIGH',
      hasEquivalentRoute: true,
      review: { status: 'VENUE_REVIEWED', reviewedAt: '2026-08-19T12:00:00.000Z' },
      segments: [
        {
          connectionId: 'fixture-lobby',
          kind: 'WALKWAY',
          accessible: true,
          directions: 'Follow the lobby signs to the lift.',
        },
        {
          connectionId: 'fixture-lift',
          kind: 'ELEVATOR',
          accessible: true,
          directions: 'Take the lift and turn left.',
        },
      ],
    },
  }
  return values[procedure] ?? null
}

async function emitTool(
  page: Page,
  responseId: string,
  name: string,
  args: Record<string, unknown>,
) {
  await page.evaluate(
    ({ responseId, name, args }) => {
      const emit = (window as unknown as { __voiceRouteEmit: (event: unknown) => void })
        .__voiceRouteEmit
      emit({ type: 'response.created', response: { id: responseId } })
      emit({
        type: 'response.done',
        event_id: `${responseId}-done`,
        response: {
          id: responseId,
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name,
              call_id: `${responseId}-call`,
              arguments: JSON.stringify(args),
            },
          ],
        },
      })
    },
    { responseId, name, args },
  )
}

test('real VoiceControl dispatches reviewed route tools through local browser seams', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await installLocalBrowserSeams(page)
  const routeRequest = deferred()
  const delayedRouteSettled = deferred()
  let delayNextRoute = false
  const trpcCalls: Array<{ procedure: string; input: unknown }> = []
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      if (url.pathname.startsWith('/api/trpc/')) {
        const procedures = decodeURIComponent(url.pathname.split('/api/trpc/')[1] ?? '').split(',')
        const rawInput =
          route.request().method() === 'POST'
            ? (route.request().postDataJSON() as Record<string, { json?: unknown }> | null)
            : JSON.parse(url.searchParams.get('input') ?? '{}')
        for (const [index, procedure] of procedures.entries()) {
          trpcCalls.push({
            procedure,
            input: rawInput?.[String(index)]?.json ?? rawInput?.[String(index)] ?? null,
          })
        }
        if (procedures.includes('location.route') && delayNextRoute) await routeRequest.promise
        const envelopes = procedures.map((procedure) => ({
          result: { data: { json: trpcPayload(procedure) } },
        }))
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(url.searchParams.get('batch') === '1' ? envelopes : envelopes[0]),
        })
        if (procedures.includes('location.route') && delayNextRoute) delayedRouteSettled.release()
        return
      }
      await route.continue()
      return
    }
    if (url.hostname === 'api.openai.com') {
      await route.fulfill({ status: 200, contentType: 'application/sdp', body: 'v=0\r\n' })
      return
    }
    await route.abort('blockedbyclient')
  })

  await page.goto(fixtureUrl)
  await expect(page.getByRole('heading', { name: 'Voice route tools' })).toBeVisible()
  const start = page.getByRole('button', { name: 'Start voice conversation' })
  await expect(start).toBeVisible()
  await start.click()
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __voiceRouteGetUserMediaCalls: () => number }
        ).__voiceRouteGetUserMediaCalls(),
      ),
    )
    .toBe(1)
  await expect(page.getByRole('button', { name: 'End voice conversation' })).toBeVisible()
  await expect(page.getByTestId('voice-route-last-event')).toContainText('Voice state: listening')

  const sentAfterOpen = await page.evaluate(() =>
    (window as unknown as { __voiceRouteSent: () => string[] }).__voiceRouteSent(),
  )
  expect(sentAfterOpen.join('\n')).toContain('lookup_venue_knowledge')
  expect(sentAfterOpen.join('\n')).toContain('list_reviewed_route_locations')
  expect(sentAfterOpen.join('\n')).toContain('lookup_reviewed_route')

  await emitTool(page, 'knowledge-response', 'lookup_venue_knowledge', {
    query: 'Where is the lake gallery?',
  })
  await expect
    .poll(() => trpcCalls.map(({ procedure }) => procedure))
    .toContain('voice.groundingContext')
  expect(
    trpcCalls.find(({ procedure }) => procedure === 'voice.groundingContext')?.input,
  ).toMatchObject({ query: 'Where is the lake gallery?', voiceSessionId: expect.any(String) })

  await emitTool(page, 'catalog-response', 'list_reviewed_route_locations', { offset: 0 })
  await expect.poll(() => trpcCalls.map(({ procedure }) => procedure)).toContain('location.catalog')
  await expect
    .poll(async () =>
      (
        await page.evaluate(() =>
          (window as unknown as { __voiceRouteSent: () => string[] }).__voiceRouteSent(),
        )
      ).join('\n'),
    )
    .toContain('fixture-main-entrance')

  await emitTool(page, 'route-response', 'lookup_reviewed_route', {
    fromLocationId: 'fixture-main-entrance',
    toLocationId: 'fixture-lake-gallery',
    accessibleOnly: true,
  })
  await expect.poll(() => trpcCalls.map(({ procedure }) => procedure)).toContain('location.route')
  expect(trpcCalls.find(({ procedure }) => procedure === 'location.route')?.input).toEqual({
    venueId: '11111111-1111-4111-8111-111111111111',
    anonymousToken: '123e4567-e89b-42d3-a456-426614174000',
    fromLocationId: 'fixture-main-entrance',
    toLocationId: 'fixture-lake-gallery',
    accessibleOnly: true,
  })
  await expect
    .poll(async () =>
      (
        await page.evaluate(() =>
          (window as unknown as { __voiceRouteSent: () => string[] }).__voiceRouteSent(),
        )
      ).join('\n'),
    )
    .toContain('fixture-lift')
  const successfulRouteMessages = await page.evaluate(() =>
    (window as unknown as { __voiceRouteSent: () => string[] }).__voiceRouteSent(),
  )
  const successfulRouteOutput = successfulRouteMessages
    .map((value) => JSON.parse(value) as { item?: { call_id?: string; output?: string } })
    .find((value) => value.item?.call_id === 'route-response-call')
  expect(successfulRouteOutput?.item?.output).toContain('VENUE_REVIEWED')
  expect(successfulRouteOutput?.item?.output).toContain('fixture-lift')
  expect(successfulRouteOutput?.item?.output).toContain('guidanceConfidence')
  expect(successfulRouteOutput?.item?.output).toContain('upper')

  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath(`voice-route-active-${page.viewportSize()!.width}.png`),
  })
  delayNextRoute = true
  await emitTool(page, 'stale-route-response', 'lookup_reviewed_route', {
    fromLocationId: 'fixture-main-entrance',
    toLocationId: 'fixture-lake-gallery',
    accessibleOnly: true,
  })
  await expect
    .poll(() => trpcCalls.filter(({ procedure }) => procedure === 'location.route').length)
    .toBe(2)
  await page.getByRole('button', { name: 'End voice conversation' }).click()
  routeRequest.release()
  await delayedRouteSettled.promise
  await page.waitForTimeout(100)
  await expect(page.getByRole('button', { name: 'Start voice conversation' })).toBeVisible()
  const sentAfterStaleRoute = await page.evaluate(() =>
    (window as unknown as { __voiceRouteSent: () => string[] }).__voiceRouteSent(),
  )
  expect(
    sentAfterStaleRoute.some((value) => value.includes('"call_id":"stale-route-response-call"')),
  ).toBe(false)

  expect(pageErrors).toEqual([])
  const bounds = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }))
  expect(bounds.body, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.viewport + 1)
  expect(bounds.document, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.viewport + 1)
  await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath(`voice-route-tools-${page.viewportSize()!.width}.png`),
  })
})
