import { beforeEach, describe, expect, it, vi } from 'vitest'

const { checkRateLimitMock } = vi.hoisted(() => ({ checkRateLimitMock: vi.fn() }))
vi.mock('../lib/rate-limit', () => ({ checkRateLimit: checkRateLimitMock }))
vi.mock('../lib/custom-character-publication', () => ({
  resolvePublishedCustomCharacterProjection: vi.fn(),
}))
vi.mock('@pathfinder/analytics', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@pathfinder/jobs', () => ({
  enqueueEmbedKnowledgeEntry: vi.fn().mockResolvedValue(undefined),
  enqueueEmbedPlace: vi.fn().mockResolvedValue(undefined),
}))

import type { TRPCContext } from '../context'
import { router } from '../core'
import { mintGuestPreviewToken } from '../lib/guest-preview-token'
import { guestPreviewRouter } from './guest-preview'
import { venueRouter } from './venue'

const SECRET = 'a-server-only-preview-signing-secret-32+'
const TENANT = 'tenant_a'
const VENUE = 'venue_a'
const SLUG = 'draft-venue'

const state = {
  venue: {
    name: 'Draft Venue',
    slug: SLUG,
    description: 'A draft guide',
    guideNotes: null,
    aiGuideNotes: null,
    aiFeaturedPlaceId: null,
    aiTone: null,
    tonePreset: null,
    tonePresetVersion: null,
    aiGuideName: 'Guide',
    chatTheme: 'default',
    chatAccentColor: null,
    chatFont: null,
    chatLogoUrl: null,
    chatBannerUrl: null,
    category: 'zoo',
    guideMode: 'location_aware',
    defaultCenterLat: null,
    defaultCenterLng: null,
    geoBoundary: null,
    isActive: false,
  },
  venueBotConfiguration: {
    presentationMode: 'CLASSIC',
    personalityMode: 'PRESET',
    tonePreset: 'friendly',
    tonePresetVersion: 1,
    responseDepth: 'BALANCED',
    personalityProfileId: null,
    characterKey: null,
    customCharacterId: null,
    publicDisplayName: null,
    greeting: null,
    voiceProfileId: null,
  },
  places: [
    {
      id: 'place_1',
      name: 'Lion House',
      type: 'exhibit',
      itemType: null,
      shortDescription: 'Big cats',
      longDescription: null,
      lat: null,
      lng: null,
      tags: [],
      importanceScore: 0,
      areaName: null,
      hours: '9-5',
      photoUrl: null,
      isActive: true,
      sourceType: 'UNKNOWN',
      authorship: 'UNKNOWN',
      sourceName: null,
      sourceUrl: null,
      importedAt: null,
      humanConfirmedAt: null,
      humanConfirmedBy: null,
      lastReviewedAt: null,
      lastReviewedBy: null,
      sourcePackageId: null,
    },
  ],
  knowledgeEntries: [
    {
      id: 'k_1',
      title: 'Tickets',
      category: 'General',
      content: 'Tickets cost 10.',
      isEnabled: true,
      sourceType: 'UNKNOWN',
      authorship: 'UNKNOWN',
      sourceName: null,
      sourceUrl: null,
      importedAt: null,
      humanConfirmedAt: null,
      humanConfirmedBy: null,
      lastReviewedAt: null,
      lastReviewedBy: null,
      sourcePackageId: null,
    },
  ],
  generalizedModules: [],
}

const venueFindFirst = vi.fn()
const releaseFindFirst = vi.fn()
const queryRaw = vi.fn()
const db = {
  venue: { findFirst: venueFindFirst },
  nativeVenueDeploymentRelease: { findFirst: releaseFindFirst },
  $queryRaw: queryRaw,
} as unknown as TRPCContext['db']
const anonymous = {
  userId: null,
  activeTenantId: null,
  role: null,
  isPlatformAdmin: false,
} as const
const caller = router({ guestPreview: guestPreviewRouter, venue: venueRouter }).createCaller({
  db,
  headers: new Headers(),
  session: anonymous,
})

function token(overrides: Partial<Parameters<typeof mintGuestPreviewToken>[0]> = {}) {
  return mintGuestPreviewToken({
    secret: SECRET,
    tenantId: TENANT,
    venueId: VENUE,
    kind: 'release',
    versionId: 'rel_1',
    ...overrides,
  }).token
}

/** Behaves like the real tenant- and venue-bound lookup: a different scope finds nothing. */
function installDatabase() {
  venueFindFirst.mockImplementation(
    async ({ where }: { where: { id: string; tenantId: string; slug: string } }) =>
      where.id === VENUE && where.tenantId === TENANT && where.slug === SLUG ? { id: VENUE } : null,
  )
  releaseFindFirst.mockImplementation(
    async ({ where }: { where: { id: string; tenantId: string; venueId: string } }) =>
      where.id === 'rel_1' && where.tenantId === TENANT && where.venueId === VENUE
        ? { status: 'DRAFT', plan: { desired: state } }
        : null,
  )
}

describe('guest preview route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('GUEST_PREVIEW_SIGNING_SECRET', SECRET)
    checkRateLimitMock.mockResolvedValue(true)
    installDatabase()
  })

  it('renders the exact bound version for a valid link, even for an inactive venue', async () => {
    const result = await caller.guestPreview.getByToken({ slug: SLUG, token: token() })
    expect(result.version).toMatchObject({ kind: 'release', id: 'rel_1', status: 'DRAFT' })
    expect(result.places.map((place) => place.name)).toEqual(['Lion House'])
    expect(result.knowledgeEntries.map((entry) => entry.title)).toEqual(['Tickets'])
    expect(result.readOnly).toBe(true)
    // Tenant and venue come from the verified claim, never from request input.
    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: VENUE, tenantId: TENANT, slug: SLUG },
      select: { id: true },
    })
    expect(releaseFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rel_1', tenantId: TENANT, venueId: VENUE } }),
    )
  })

  it('answers every refusal identically and does no database work for a bad signature', async () => {
    const good = token()
    const [prefix, body, signature] = good.split('.') as [string, string, string]
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    const forged = Buffer.from(JSON.stringify({ ...claims, n: 'venue_b' })).toString('base64url')
    const tampered = `${prefix}.${forged}.${signature}`
    const expired = mintGuestPreviewToken({
      secret: SECRET,
      tenantId: TENANT,
      venueId: VENUE,
      kind: 'release',
      versionId: 'rel_1',
      now: new Date(Date.now() - 2 * 60 * 60 * 1_000),
      ttlSeconds: 60,
    }).token

    for (const attempt of [tampered, expired, 'not-a-token']) {
      await expect(
        caller.guestPreview.getByToken({ slug: SLUG, token: attempt }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Preview not found',
      })
    }
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(releaseFindFirst).not.toHaveBeenCalled()
  })

  it('rejects a link used on another venue slug or minted for another tenant', async () => {
    await expect(
      caller.guestPreview.getByToken({ slug: 'other-venue', token: token() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Preview not found' })
    await expect(
      caller.guestPreview.getByToken({ slug: SLUG, token: token({ venueId: 'venue_b' }) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      caller.guestPreview.getByToken({ slug: SLUG, token: token({ tenantId: 'tenant_b' }) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      caller.guestPreview.getByToken({ slug: SLUG, token: token({ versionId: 'rel_other' }) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('fails closed without a signing secret and when rate limited', async () => {
    const minted = token()
    vi.stubEnv('GUEST_PREVIEW_SIGNING_SECRET', '')
    await expect(
      caller.guestPreview.getByToken({ slug: SLUG, token: minted }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    vi.stubEnv('GUEST_PREVIEW_SIGNING_SECRET', SECRET)
    checkRateLimitMock.mockResolvedValue(false)
    await expect(
      caller.guestPreview.getByToken({ slug: SLUG, token: minted }),
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    })
  })

  it('never exposes a version that fails its own contract', async () => {
    releaseFindFirst.mockResolvedValue({ status: 'DRAFT', plan: { desired: { places: 'nope' } } })
    await expect(
      caller.guestPreview.getByToken({ slug: SLUG, token: token() }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('keeps the public route closed for the same draft venue while the preview works', async () => {
    queryRaw.mockResolvedValueOnce([{ isActive: false }])
    await expect(caller.venue.getBySlug({ slug: SLUG })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
    await expect(
      caller.guestPreview.getByToken({ slug: SLUG, token: token() }),
    ).resolves.toMatchObject({
      version: { id: 'rel_1' },
    })
  })
})
