import { readFileSync } from 'node:fs'

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '../../../apps/dashboard/node_modules/@playwright/test'

const webOrigin = process.env.TORCHIKO_DISTRIBUTION_WEB_ORIGIN ?? 'https://localhost:4173'
const fixtureOrigin = process.env.TORCHIKO_DISTRIBUTION_FIXTURE_ORIGIN ?? 'https://127.0.0.1:4174'
const controlToken = process.env.TORCHIKO_DISTRIBUTION_CONTROL_TOKEN
const controlUrl = `http://127.0.0.1:${process.env.TORCHIKO_DISTRIBUTION_CONTROL_PORT ?? '4176'}/__state`
const manifest = process.env.TORCHIKO_DISTRIBUTION_FIXTURE_MANIFEST
const realStack = process.env.TORCHIKO_DISTRIBUTION_REAL_STACK === '1'

if (
  realStack &&
  (new URL(webOrigin).origin !== 'https://localhost:4173' ||
    new URL(fixtureOrigin).origin !== 'https://127.0.0.1:4174')
) {
  throw new Error(
    'The real-stack proof requires two distinct HTTPS origins: localhost and 127.0.0.1.',
  )
}
if (realStack && (!controlToken || !manifest))
  throw new Error('Real-stack proof requires the private fixture-control token and manifest path.')

const fixture = (realStack ? JSON.parse(readFileSync(manifest!, 'utf8')) : {}) as {
  admittedOrigins: Record<
    'launcher' | 'inline' | 'unadmitted' | 'revoke' | 'disabled' | 'paused',
    string
  >
  slugs: Record<'launcher' | 'inline' | 'unadmitted' | 'revoke' | 'disabled' | 'paused', string>
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === webOrigin || url.origin === fixtureOrigin) await route.continue()
    else await route.abort('blockedbyclient')
  })
})

function hostUrl(mode: string, scenario: keyof typeof fixture.slugs, origin = fixtureOrigin) {
  const params = new URLSearchParams({ webOrigin, venue: fixture.slugs[scenario] })
  return `${origin}/${mode}?${params}`
}

async function control(request: APIRequestContext, scenario: string) {
  const response = await request.post(controlUrl, {
    headers: { authorization: `Bearer ${controlToken}` },
    data: { scenario },
  })
  expect(response.status()).toBe(200)
}

function expectCrossSiteObservation(slug: string) {
  const logPath = process.env.TORCHIKO_DISTRIBUTION_REQUEST_LOG
  if (!logPath) throw new Error('Real-stack proof is missing the local proxy request log path.')
  const observations = readFileSync(logPath, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          path: string
          origin: string | null
          secFetchSite: string | null
        },
    )
  const observation = observations.find((entry) => entry.path.endsWith(`/api/widget-ready/${slug}`))
  expect(observation, `No proxy-side request metadata captured for ${slug}`).toBeDefined()
  expect(observation?.origin).toBe(fixtureOrigin)
  // Chromium's Playwright protocol may omit Fetch Metadata from Request objects;
  // the task-local proxy records its actual inbound value for evidence.
  return observation?.secFetchSite ?? null
}

async function expireResolverCache(page: Page) {
  await test.step('wait beyond the 30-second successful resolver cache TTL', async () => {
    await page.waitForTimeout(31_000)
  })
}

test('@real admitted HTTPS site launches the real embed, checks cross-site headers, and confirms a new conversation', async ({
  page,
  request,
}) => {
  const slug = fixture.slugs.launcher
  await page.route('**/api/chat-stream', async (route) => {
    const result = {
      response: 'Synthetic local answer for the confirmation flow.',
      replyKind: 'ANSWER',
      assistantMessageId: 'p7-a5-synthetic-answer',
      sessionId: 'p7-a5-synthetic-session',
      places: [],
      citations: [],
      replayed: false,
      providerFirstTextMs: null,
      requestFirstTextMs: null,
    }
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
      },
      body: `${JSON.stringify({ type: 'complete', result })}\n`,
    })
  })

  const probeResponsePromise = page.waitForResponse((candidate) =>
    candidate.url().includes(`/api/widget-ready/${slug}`),
  )
  await page.goto(hostUrl('launcher', 'launcher'))
  await probeResponsePromise
  expect(new URL(page.url()).origin).toBe(fixtureOrigin)
  expect(new URL(webOrigin).origin).not.toBe(fixtureOrigin)
  const observedSecFetchSite = expectCrossSiteObservation(slug)
  if (observedSecFetchSite !== null) expect(observedSecFetchSite).toBe('cross-site')

  const launcher = page.locator('.pf-launcher')
  await expect(launcher).toBeVisible({ timeout: 15_000 })
  await expect(launcher).toContainText('Ask P7 Guide')
  const embedResponsePromise = page.waitForResponse((candidate) =>
    candidate.url().endsWith(`/embed/${slug}`),
  )
  await launcher.click()
  const frame = page.locator('iframe[data-pathfinder-widget-frame]')
  await expect(frame).toBeVisible({ timeout: 15_000 })
  await expect(frame).toHaveAttribute('src', new RegExp(`/embed/${slug}$`))
  await expect(frame).toHaveAttribute('sandbox', /allow-same-origin/)
  const response = await embedResponsePromise
  expect(response.status()).toBe(200)
  expect(response.headers()['content-security-policy']).toContain(
    `frame-ancestors 'self' ${fixture.admittedOrigins.launcher}`,
  )

  const guide = page.frameLocator('iframe[data-pathfinder-widget-frame]')
  const question = 'P7 synthetic confirmation question'
  await guide.getByRole('textbox', { name: 'Question' }).fill(question)
  await guide.getByRole('button', { name: 'Send' }).click()
  await expect(guide.getByText(question)).toBeVisible({ timeout: 10_000 })
  await expect(
    guide.getByText('Synthetic local answer for the confirmation flow.').first(),
  ).toBeVisible()

  const identityBeforeReopen = await page
    .frames()
    .find((candidate) => candidate.url().includes(`/embed/${slug}`))
    ?.evaluate(() => {
      const key = Object.keys(window.sessionStorage).find((candidate) =>
        candidate.startsWith('pathfinder_session_'),
      )
      return key ? window.sessionStorage.getItem(key) : null
    })
  expect(identityBeforeReopen).toMatch(/^[0-9a-f-]{36}$/iu)
  await page.getByRole('button', { name: /close/i }).click()
  await expect(launcher).toBeVisible()
  await launcher.click()
  await expect(frame).toBeVisible()
  const reopenedFrame = page
    .frames()
    .find((candidate) => candidate.url().includes(`/embed/${slug}`))
  const identityAfterReopen = await reopenedFrame?.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) =>
      candidate.startsWith('pathfinder_session_'),
    )
    return key ? window.sessionStorage.getItem(key) : null
  })
  expect(identityAfterReopen).toBe(identityBeforeReopen)

  // The synthetic response is UI-only. It is intentionally absent from DB
  // history, so send a second synthetic response after reopening for A1.
  await guide.getByRole('textbox', { name: 'Question' }).fill('P7 confirmation after reopen')
  await guide.getByRole('button', { name: 'Send' }).click()
  await expect(guide.getByText('P7 confirmation after reopen')).toBeVisible()
  await guide.getByRole('button', { name: 'Settings' }).click()
  await guide.getByRole('button', { name: 'Clear chat' }).click()
  const dialog = guide.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAccessibleName('Clear chat')
  await dialog.getByRole('button', { name: /cancel/i }).click()
  await expect(guide.getByText('P7 confirmation after reopen')).toBeVisible()
  await guide.getByRole('button', { name: 'Settings' }).click()
  await guide.getByRole('button', { name: 'Clear chat' }).click()
  const confirmed = guide.getByRole('alertdialog')
  await confirmed.getByRole('button', { name: 'Clear chat' }).click()
  await expect(guide.getByText('P7 confirmation after reopen')).toHaveCount(0)

  const appResponse = await request.get(`${webOrigin}/app/${slug}`)
  expect(appResponse.status()).toBe(200)
  expect(appResponse.headers()['x-frame-options']).toBe('SAMEORIGIN')
})

test('@real admitted inline host mounts the real inline route over cross-site HTTPS', async ({
  page,
}) => {
  const slug = fixture.slugs.inline
  const probeResponsePromise = page.waitForResponse((candidate) =>
    candidate.url().includes(`/api/widget-ready/${slug}`),
  )
  await page.goto(hostUrl('inline', 'inline'))
  await probeResponsePromise
  const observedSecFetchSite = expectCrossSiteObservation(slug)
  if (observedSecFetchSite !== null) expect(observedSecFetchSite).toBe('cross-site')
  const container = page.locator('[data-torchiko-inline]')
  const frame = container.locator('iframe[data-pathfinder-widget-frame]')
  await expect(frame).toBeVisible({ timeout: 15_000 })
  await expect(frame).toHaveAttribute('src', new RegExp(`/embed/${slug}/inline$`))
  await expect(page.locator('.pf-launcher')).toHaveCount(0)
})

test('@real bridge opens an admitted guide with unsent ask and ignores spoofed lifecycle', async ({
  page,
}) => {
  await page.goto(hostUrl('launcher', 'launcher'))
  await expect(page.locator('.pf-launcher')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(() => {
    const host = window as typeof window & {
      Torchiko: {
        open: (options: { ask: string }) => void
        close: () => void
        on: (event: 'ready' | 'open' | 'close', handler: () => void) => void
      }
      bridgeEvents: string[]
    }
    host.bridgeEvents = []
    for (const event of ['ready', 'open', 'close'] as const)
      host.Torchiko.on(event, () => host.bridgeEvents.push(event))
    host.Torchiko.open({ ask: 'Where is the entrance?' })
  })
  const frame = page.locator('iframe[data-pathfinder-widget-frame]')
  await expect(frame).toBeVisible({ timeout: 15_000 })
  const guide = page.frameLocator('iframe[data-pathfinder-widget-frame]')
  await expect(guide.getByRole('textbox', { name: 'Question' })).toHaveValue(
    'Where is the entrance?',
  )
  await expect(guide.getByRole('log').getByText('Where is the entrance?')).toHaveCount(0)
  const beforeSpoof = await page.evaluate(
    () => (window as typeof window & { bridgeEvents: string[] }).bridgeEvents.length,
  )
  await frame.evaluate((iframe) => {
    const frameWindow = (iframe as HTMLIFrameElement).contentWindow
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://spoofed.example',
        source: frameWindow,
        data: { source: 'torchiko', v: 1, type: 'open', payload: null },
      }),
    )
  })
  expect(
    await page.evaluate(
      () => (window as typeof window & { bridgeEvents: string[] }).bridgeEvents.length,
    ),
  ).toBe(beforeSpoof)
  await page.evaluate(() =>
    (window as typeof window & { Torchiko: { close: () => void } }).Torchiko.close(),
  )
  await expect(frame).toBeHidden()
  const events = await page.evaluate(
    () => (window as typeof window & { bridgeEvents: string[] }).bridgeEvents,
  )
  expect(events).toContain('ready')
  expect(events).toContain('open')
  expect(events).toContain('close')
})

test('@real app route header=none opens in browser mobile emulation with unsent ask', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'phone-390',
    'This is the labeled mobile-emulation app check.',
  )
  const slug = fixture.slugs.launcher
  const response = await page.goto(
    `${webOrigin}/app/${slug}?header=none&ask=${encodeURIComponent('What can I see here?')}`,
  )
  expect(response?.status()).toBe(200)
  expect(response?.headers()['x-frame-options']).toBe('SAMEORIGIN')
  await expect(page.getByRole('textbox', { name: 'Question' })).toHaveValue('What can I see here?')
  await expect(page.getByRole('log').getByText('What can I see here?')).toHaveCount(0)
  await expect(page.locator('[data-app-header]')).toHaveCount(0)
  await expect(page.getByRole('link', { name: /back/i })).toHaveCount(0)
})

test('@real unadmitted HTTPS host has no launcher and cannot be framed', async ({
  page,
  request,
}) => {
  const slug = fixture.slugs.unadmitted
  const unadmittedOrigin = fixtureOrigin
  await page.goto(hostUrl('unadmitted', 'unadmitted', unadmittedOrigin))
  await expect(page.locator('[data-pathfinder-widget]')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('iframe[data-pathfinder-widget-frame]')).toHaveCount(0)

  const probe = await request.get(`${webOrigin}/api/widget-ready/${slug}?v=2`, {
    headers: { origin: unadmittedOrigin },
  })
  expect(probe.status()).toBe(404)
  const blockedEmbedResponse = page.waitForResponse((candidate) =>
    candidate.url().endsWith(`/embed/${slug}`),
  )
  await page.locator('body').evaluate((body, src) => {
    const iframe = document.createElement('iframe')
    iframe.id = 'manual-unadmitted-frame'
    iframe.src = src
    body.appendChild(iframe)
  }, `${webOrigin}/embed/${slug}`)
  const blockedResponse = await blockedEmbedResponse
  expect(
    blockedResponse.status(),
    `Unexpected redirect location: ${(await blockedResponse.allHeaders()).location ?? '(none)'}`,
  ).toBe(200)
  const framePolicy = (await blockedResponse.allHeaders())['content-security-policy']
  expect(framePolicy).toBe(`frame-ancestors 'self' ${fixture.admittedOrigins.unadmitted}`)
  expect(framePolicy).not.toContain(` ${unadmittedOrigin}`)
  const blockedFrame = page.locator('#manual-unadmitted-frame')
  await expect(blockedFrame).toBeVisible()
  const childFrame = await blockedFrame.elementHandle().then((handle) => handle?.contentFrame())
  expect(childFrame).not.toBeNull()
  expect(childFrame!.url()).toMatch(/^chrome-error:\/\/chromewebdata\/$/u)
  await expect(blockedFrame.contentFrame().locator('body')).not.toContainText(
    'Synthetic P7 unadmitted venue',
  )
})

test('@real revoking an admitted origin hides the loader after resolver TTL', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000)
  test.skip(
    testInfo.project.name !== 'desktop-1280',
    'The TTL expiry proof runs once; phone project covers the active real route.',
  )
  const slug = fixture.slugs.revoke
  await page.goto(hostUrl('launcher', 'revoke'))
  await expect(page.locator('.pf-launcher')).toBeVisible({ timeout: 15_000 })
  await control(request, 'revoke')
  await expireResolverCache(page)
  await page.reload()
  await expect(page.locator('[data-pathfinder-widget]')).toHaveCount(0, { timeout: 15_000 })
  const response = await request.get(`${webOrigin}/api/widget-ready/${slug}?v=2`, {
    headers: { origin: fixtureOrigin },
  })
  expect(response.status()).toBe(404)
})

test('@real website surface DISABLED fails invisible', async ({ page, request }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-1280',
    'Phone width is covered by the admitted launcher and inline cases.',
  )
  const slug = fixture.slugs.disabled
  await page.goto(hostUrl('launcher', 'disabled'))
  await expect(page.locator('[data-pathfinder-widget]')).toHaveCount(0, { timeout: 15_000 })
  expect(
    (
      await request.get(`${webOrigin}/api/widget-ready/${slug}?v=2`, {
        headers: { origin: fixtureOrigin },
      })
    ).status(),
  ).toBe(404)
})

test('@real paused venue fails invisible', async ({ page, request }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-1280',
    'Phone width is covered by the admitted launcher and inline cases.',
  )
  const slug = fixture.slugs.paused
  await page.goto(hostUrl('launcher', 'paused'))
  await expect(page.locator('[data-pathfinder-widget]')).toHaveCount(0, { timeout: 15_000 })
  expect(
    (
      await request.get(`${webOrigin}/api/widget-ready/${slug}?v=2`, {
        headers: { origin: fixtureOrigin },
      })
    ).status(),
  ).toBe(404)
})
