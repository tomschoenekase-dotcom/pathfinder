import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

const dashboardBaseUrl = 'http://localhost:56346'
const allowedOrigins = new Set([dashboardBaseUrl])
const packet12PublishedR2Sha = 'ef0c3760fcc3e97fe95c1ed9252c579097582a0b'
const syntheticTerritoryId = 'territory_p14_synthetic_central'

const viewports = [
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const

function assertPublishedR2IsAncestor() {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', packet12PublishedR2Sha, 'HEAD'], {
      cwd: process.cwd(),
      stdio: 'ignore',
    })
  } catch {
    throw new Error(
      `Packet 14 admin proof requires published Packet 12 R2 ${packet12PublishedR2Sha} in HEAD ancestry.`,
    )
  }
}

async function blockNonLoopbackRequests(page: Page) {
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

async function signInAsPlatformAdmin(page: Page) {
  await page.goto(`${dashboardBaseUrl}/sign-in`)
  await page.locator('select[name="identity"]').selectOption({ label: 'Platform admin' })
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(`${dashboardBaseUrl}/admin`)
}

async function signOut(page: Page) {
  const openNavigation = page.getByRole('button', { name: 'Open navigation' })
  if (await openNavigation.isVisible().catch(() => false)) await openNavigation.click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/sign-in(?:\?|$)/u)
}

test('platform admin reviews seeded Good fit CRM and visitor speed at phone and desktop widths', async ({
  page,
}, testInfo) => {
  assertPublishedR2IsAncestor()
  test.setTimeout(180_000)
  test.skip(
    testInfo.project.name !== 'phone-390x844',
    'This test explicitly covers phone and desktop widths in one run.',
  )

  const externalRequests = await blockNonLoopbackRequests(page)
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await signInAsPlatformAdmin(page)
    await page.goto(
      `${dashboardBaseUrl}/admin/prospects?goodFit=true&territoryId=${encodeURIComponent(syntheticTerritoryId)}`,
    )

    await expect(page.getByRole('heading', { name: 'Prospect directory' })).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Good fit · S–L · no recorded outreach' }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByLabel('Prospect territory')).toHaveValue(syntheticTerritoryId)

    const museum = page.getByRole('link', { name: /Lantern Field Museum Cooperative/u })
    await expect(museum).toBeVisible()
    await expect(museum).toContainText(
      'Supported category: museum. Founder priority is MID_TIER_PRIORITY. Official annual attendance evidence: 120000 visitors/year. Venue has an assigned territory.',
    )
    await expect(page.getByText('Comet Bowl Stadium Group', { exact: true })).toHaveCount(0)

    const speedResponse = await page.evaluate(async () => {
      const response = await fetch('/api/trpc/admin.getVisitorSpeed', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        body: await response.json(),
      }
    })
    expect(speedResponse.status).toBe(200)
    expect(speedResponse.contentType).toMatch(/application\/json/iu)

    const envelope = speedResponse.body as {
      result?: { data?: { json?: unknown } | unknown }
    }
    const resultData = envelope.result?.data
    const speed =
      resultData && typeof resultData === 'object' && 'json' in resultData
        ? (resultData as { json: unknown }).json
        : resultData
    expect(speed).toEqual(
      expect.objectContaining({
        windowStart: expect.any(String),
        windowEnd: expect.any(String),
        venues: expect.any(Array),
      }),
    )
    const speedReadout = speed as {
      windowStart: string
      windowEnd: string
      venues: Array<{
        tenantId: string
        venueId: string
        venueName: string
        sampleCount: number
        p50RequestFirstTextMs: number
        p90RequestFirstTextMs: number
      }>
    }
    expect(Date.parse(speedReadout.windowStart)).toBeLessThan(Date.parse(speedReadout.windowEnd))
    const auroraSpeed = speedReadout.venues.find(
      ({ venueId }) => venueId === 'cpacket14aurora0000000000',
    )
    expect(auroraSpeed).toBeDefined()
    expect(auroraSpeed!.tenantId).toBe('org_LocalTenantA')
    expect(auroraSpeed!.venueName).toBe('Aurora Science Museum')
    expect(auroraSpeed!.sampleCount).toBeGreaterThanOrEqual(2)
    expect(auroraSpeed!.p50RequestFirstTextMs).toEqual(expect.any(Number))
    expect(auroraSpeed!.p50RequestFirstTextMs).toBeGreaterThanOrEqual(0)
    expect(auroraSpeed!.p90RequestFirstTextMs).toEqual(expect.any(Number))
    expect(auroraSpeed!.p90RequestFirstTextMs).toBeGreaterThanOrEqual(
      auroraSpeed!.p50RequestFirstTextMs,
    )
    await testInfo.attach(`admin-visitor-speed-${viewport.name}`, {
      body: JSON.stringify(speedReadout),
      contentType: 'application/json',
    })

    await page.screenshot({
      path: testInfo.outputPath(`local-full-stack-admin-${viewport.name}.png`),
      fullPage: true,
    })

    await signOut(page)
    expect(externalRequests).toEqual([])
  }
})
