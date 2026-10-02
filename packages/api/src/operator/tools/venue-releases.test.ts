/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory Prisma fakes are loosely typed on purpose */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  snapshot: vi.fn(),
  assess: vi.fn(),
  measure: vi.fn(),
  published: vi.fn(),
}))

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  resolveNativeGuestReadSnapshotAction: native.snapshot,
  assessNativeGuestReadActivationAction: native.assess,
  measureNativeContentConvergenceAction: native.measure,
  resolveEffectivePublishedUniversalContent: native.published,
}))

import { verifyGuestPreviewToken } from '../../lib/guest-preview-token'
import { OperatorNotFoundError } from '../grants'
import { evaluatePreflight, preflightReady, type PreflightFacts } from '../release-preflight'
import type { OperatorCallContext } from '../registry'
import { OPERATOR_READ_TOOLS } from './index'

const TENANT = 'tenant_a'
const VENUE = 'venue_a'
const NOW = new Date('2026-10-02T12:00:00.000Z')
const SECRET = 'a-server-only-preview-signing-secret-32+'
const hash = (char: string) => char.repeat(64)

const desired = {
  venue: {
    name: 'Venue A',
    slug: 'venue-a',
    description: null,
    guideNotes: null,
    aiGuideNotes: null,
    aiFeaturedPlaceId: null,
    aiTone: null,
    tonePreset: null,
    tonePresetVersion: null,
    aiGuideName: null,
    chatTheme: null,
    chatAccentColor: null,
    chatFont: null,
    chatLogoUrl: null,
    chatBannerUrl: null,
    category: null,
    guideMode: 'location_aware',
    defaultCenterLat: null,
    defaultCenterLng: null,
    geoBoundary: null,
    isActive: true,
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
  places: [],
  knowledgeEntries: [],
  generalizedModules: [],
}

const releases: Array<Record<string, any>> = []
const packages: Array<Record<string, any>> = []
const state = { head: null as null | Record<string, any>, venueActive: true, secondLayerPlaces: 2 }

const sameInstant = (left: Date, right: Date) => left.getTime() === right.getTime()
const rowMatches = (row: Record<string, any>, where: any): boolean => {
  if (where.OR) return where.OR.some((branch: any) => rowMatches(row, branch))
  if (where.createdAt instanceof Date && !sameInstant(row.createdAt, where.createdAt)) return false
  if (where.createdAt?.lt && !(row.createdAt < where.createdAt.lt)) return false
  if (where.id?.lt && !(row.id < where.id.lt)) return false
  return (
    (typeof where.id !== 'string' || row.id === where.id) &&
    (where.tenantId === undefined || row.tenantId === where.tenantId) &&
    (where.venueId === undefined || row.venueId === where.venueId) &&
    (where.status === undefined || row.status === where.status)
  )
}

const database: any = {
  tenant: { findUnique: async () => ({ id: TENANT }) },
  venue: {
    findFirst: async ({ where }: any) =>
      where.id === VENUE && where.tenantId === TENANT
        ? { id: VENUE, slug: 'venue-a', isActive: state.venueActive }
        : null,
  },
  nativeVenueDeploymentRelease: {
    findMany: async ({ where }: any) => releases.filter((row) => rowMatches(row, where)),
    findFirst: async ({ where }: any) => releases.find((row) => rowMatches(row, where)) ?? null,
  },
  venuePackage: {
    findMany: async ({ where }: any) => packages.filter((row) => rowMatches(row, where)),
    findFirst: async ({ where }: any) => packages.find((row) => rowMatches(row, where)) ?? null,
  },
  nativeVenueDeploymentHead: { findFirst: async () => state.head },
  nativeVenueDeploymentEvaluationEvidence: { count: async () => 1 },
  place: {
    count: async ({ where }: any) => (where.NOT ? state.secondLayerPlaces : 3),
  },
  venueKnowledgeEntry: { count: async ({ where }: any) => (where.NOT ? 1 : 5) },
  contentModuleIdentity: { count: async () => 2 },
  venuePackage_unused: undefined,
  venueDistribution: { findFirst: async () => ({ websiteState: 'DISABLED' }) },
}

const grant = (tenantIds = [TENANT]) =>
  ({
    grantId: 'grant_1',
    clientId: 'client_1',
    userId: 'user_1',
    allTenants: false,
    tenantIds,
    capabilities: ['venues:read'],
  }) as never
const context = (tenantIds = [TENANT]) =>
  ({ database, grant: grant(tenantIds), now: NOW }) as unknown as OperatorCallContext
const tool = (name: string) => OPERATOR_READ_TOOLS.find((entry) => entry.name === name)!
const base = { tenantId: TENANT, venueId: VENUE }

beforeEach(() => {
  releases.length = 0
  packages.length = 0
  state.head = null
  state.venueActive = true
  vi.stubEnv('GUEST_PREVIEW_SIGNING_SECRET', SECRET)
  vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'https://guide.example.com')
  releases.push({
    id: 'rel_1',
    tenantId: TENANT,
    venueId: VENUE,
    status: 'DRAFT',
    createdAt: new Date('2026-09-30T10:00:00Z'),
    updatedAt: new Date('2026-09-30T10:00:00Z'),
    approvedAt: null,
    appliedAt: null,
    revertedAt: null,
    manifestHash: hash('a'),
    profile: 'NATIVE_CORE_V1',
    planHash: hash('b'),
    desiredStateHash: hash('c'),
    baseStateHash: hash('d'),
    expectedEffectCount: 4,
    plan: { desired },
  })
  packages.push({
    id: 'pkg_1',
    tenantId: TENANT,
    venueId: VENUE,
    status: 'DRAFT',
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    approvedAt: null,
    appliedAt: null,
    revertedAt: null,
    payloadHash: hash('e'),
    schemaVersion: 3,
    baseDigest: hash('f'),
    validationReport: {
      errors: [{}],
      warnings: [{}, {}],
      semanticDuplicateScan: { status: 'INCOMPLETE' },
    },
    payload: { places: [{}, {}], knowledgeEntries: [{}] },
  })
  packages.push({
    id: 'pkg_applied',
    tenantId: TENANT,
    venueId: VENUE,
    status: 'APPLIED',
    createdAt: new Date('2026-08-01T10:00:00Z'),
    updatedAt: new Date('2026-08-02T10:00:00Z'),
    approvedAt: new Date('2026-08-01T11:00:00Z'),
    appliedAt: new Date('2026-08-02T10:00:00Z'),
    revertedAt: null,
    payloadHash: hash('9'),
    schemaVersion: 3,
    baseDigest: hash('8'),
    validationReport: { errors: [], warnings: [], semanticDuplicateScan: { status: 'COMPLETE' } },
    payload: { places: [], knowledgeEntries: [] },
  })
  native.snapshot.mockResolvedValue({
    path: 'LEGACY',
    reason: 'SERVER_DISABLED',
    releaseId: null,
    state: null,
  })
  native.assess.mockResolvedValue({ blockers: ['SERVER_GATE_DISABLED', 'VENUE_POLICY_MISSING'] })
  native.measure.mockResolvedValue({ phase: 'NO_NATIVE_HEAD' })
  native.published.mockResolvedValue([{}, {}])
})

describe('release reads', () => {
  it('lists native releases and package drafts newest first, with a cursor across both', async () => {
    const first = (await tool('venues.list_releases').handler(
      { ...base, limit: 2 },
      context(),
    )) as any
    expect(first.items.map((item: any) => [item.kind, item.id])).toEqual([
      ['PACKAGE_DRAFT', 'pkg_1'],
      ['NATIVE_RELEASE', 'rel_1'],
    ])
    expect(first.complete).toBe(false)
    const second = (await tool('venues.list_releases').handler(
      { ...base, limit: 2, cursor: first.nextCursor },
      context(),
    )) as any
    expect(second.items.map((item: any) => item.id)).toEqual(['pkg_applied'])
    expect(second.complete).toBe(true)
    expect(first.items[0].versionHash).toBe(hash('e'))
    expect(first.items.every((item: any) => item.isNativeHead === false)).toBe(true)
  })

  it('rejects a cursor that does not belong to this venue', async () => {
    await expect(
      tool('venues.list_releases').handler(
        { ...base, cursor: '2026-09-01T00:00:00.000Z|PACKAGE_DRAFT:not_mine' },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  })

  it('reads one release with hashes and one package with validation counts', async () => {
    const release = (await tool('venues.get_release').handler(
      { ...base, releaseKind: 'NATIVE_RELEASE', releaseId: 'rel_1' },
      context(),
    )) as any
    expect(release.release).toMatchObject({
      kind: 'NATIVE_RELEASE',
      status: 'DRAFT',
      counts: { places: 0, knowledgeEntries: 0, modules: 0 },
    })
    expect(release.detail).toMatchObject({
      profile: 'NATIVE_CORE_V1',
      planHash: hash('b'),
      evaluationEvidenceCount: 1,
    })
    const pkg = (await tool('venues.get_release').handler(
      { ...base, releaseKind: 'PACKAGE_DRAFT', releaseId: 'pkg_1' },
      context(),
    )) as any
    expect(pkg.release.counts).toEqual({ places: 2, knowledgeEntries: 1, modules: 0 })
    expect(pkg.detail.validation).toEqual({ errors: 1, warnings: 2 })
  })

  it('reports what guests are served now, from the same resolver the guest path uses', async () => {
    const result = (await tool('venues.get_effective_guest_version').handler(
      base,
      context(),
    )) as any
    expect(native.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, venueId: VENUE }),
    )
    expect(result).toMatchObject({
      venueActive: true,
      readPath: 'LEGACY',
      readPathReason: 'SERVER_DISABLED',
      nativeHead: null,
      serving: { places: 3, knowledgeEntries: 5, publishedModules: 2 },
      withheldFromGuests: {
        secondLayerPlaces: 2,
        secondLayerKnowledgeEntries: 1,
        nonPublicModules: 2,
      },
      lastAppliedPackage: { packageId: 'pkg_applied' },
    })
    expect(result.explanation).toContain('compatibility rows')
  })

  it('says so when the venue is inactive, and reports the native head when one exists', async () => {
    state.venueActive = false
    state.head = { releaseId: 'rel_1', revision: 2, updatedAt: NOW, release: { status: 'APPLIED' } }
    native.snapshot.mockResolvedValue({
      path: 'NATIVE',
      reason: 'NATIVE_READY',
      releaseId: 'rel_1',
      state: {},
    })
    native.measure.mockResolvedValue({ phase: 'NATIVE_HEAD_IN_SYNC' })
    const result = (await tool('venues.get_effective_guest_version').handler(
      base,
      context(),
    )) as any
    expect(result.nativeHead).toMatchObject({
      releaseId: 'rel_1',
      stateInSync: true,
      releaseStatus: 'APPLIED',
    })
    expect(result.explanation).toContain('not active')
    const list = (await tool('venues.list_releases').handler(base, context())) as any
    expect(list.items.find((item: any) => item.id === 'rel_1').isNativeHead).toBe(true)
  })
})

describe('release preflight lists unmet prerequisites with reasons and actions', () => {
  it('is not an opaque boolean: every unmet item says why and what clears it', async () => {
    state.venueActive = false
    const result = (await tool('venues.get_release_preflight').handler(
      { ...base, releaseKind: 'PACKAGE_DRAFT', releaseId: 'pkg_1' },
      context(),
    )) as any
    expect(result.ready).toBe(false)
    const unmet = result.prerequisites.filter((item: any) => !item.passed)
    const keys = unmet.map((item: any) => item.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        'venue_active',
        'package_status',
        'package_validation',
        'package_duplicate_scan',
        'native_read_server_gate_disabled',
        'native_read_venue_policy_missing',
      ]),
    )
    for (const item of unmet) {
      expect(item.reason.length).toBeGreaterThan(10)
      expect(item.action.length).toBeGreaterThan(10)
    }
    expect(unmet.find((item: any) => item.key === 'package_validation').reason).toContain('1 error')
    // Native-read items matter only for native serving, so they never block a release by themselves.
    expect(
      unmet
        .filter((item: any) => item.key.startsWith('native_read_'))
        .every((item: any) => item.severity === 'INFO'),
    ).toBe(true)
  })

  it('is ready only when every blocker passes', async () => {
    packages[0]!.status = 'APPROVED'
    packages[0]!.validationReport = {
      errors: [],
      warnings: [],
      semanticDuplicateScan: { status: 'COMPLETE' },
    }
    const result = (await tool('venues.get_release_preflight').handler(
      { ...base, releaseKind: 'PACKAGE_DRAFT', releaseId: 'pkg_1' },
      context(),
    )) as any
    expect(result.ready).toBe(true)
    expect(result.target).toEqual({ kind: 'PACKAGE_DRAFT', id: 'pkg_1', status: 'APPROVED' })
  })

  it('treats an unreadable assessment as unmet information, never as fine', async () => {
    native.assess.mockRejectedValue(new Error('db down'))
    const result = (await tool('venues.get_release_preflight').handler(base, context())) as any
    expect(result.prerequisites.map((item: any) => item.key)).toContain(
      'native_read_read_failed_closed',
    )
    expect(result.prerequisites.find((item: any) => item.key === 'release_selected').passed).toBe(
      false,
    )
  })

  it('evaluates native releases by status and head', () => {
    const facts: PreflightFacts = {
      venueActive: true,
      publicPlaces: 1,
      publicKnowledgeEntries: 0,
      target: { kind: 'NATIVE_RELEASE', id: 'r', status: 'REVERTED', isNativeHead: false },
      nativeReadBlockers: [],
      convergencePhase: 'NATIVE_HEAD_DRIFTED',
      previewSigningConfigured: false,
      websiteDistribution: null,
    }
    const items = evaluatePreflight(facts)
    expect(preflightReady(items)).toBe(false)
    expect(items.find((item) => item.key === 'release_status')!.action).toContain('new release')
    expect(items.find((item) => item.key === 'content_converged')!.passed).toBe(false)
    expect(items.find((item) => item.key === 'private_preview_available')!.passed).toBe(false)
  })
})

describe('venues.get_preview_link mints a private, version-bound link', () => {
  it('binds tenant, venue and the exact release, and expires soon', async () => {
    const result = (await tool('venues.get_preview_link').handler(
      { ...base, releaseKind: 'NATIVE_RELEASE', releaseId: 'rel_1' },
      context(),
    )) as any
    expect(result.url).toMatch(/^https:\/\/guide\.example\.com\/venue-a\/preview\?token=gp1\./u)
    expect(result.unavailable).toBeNull()
    const token = new URL(result.url).searchParams.get('token')!
    const claims = verifyGuestPreviewToken({
      secret: SECRET,
      token,
      now: NOW,
      expected: { tenantId: TENANT, venueId: VENUE, kind: 'release', versionId: 'rel_1' },
    })
    expect(claims.expiresAt.getTime() - claims.issuedAt.getTime()).toBe(15 * 60_000)
    // It is not the ordinary public URL: no slug-only form works, and no other version verifies.
    expect(result.url).not.toBe('https://guide.example.com/venue-a')
    expect(() =>
      verifyGuestPreviewToken({
        secret: SECRET,
        token,
        now: NOW,
        expected: { versionId: 'rel_other' },
      }),
    ).toThrow()
  })

  it('binds a package draft by kind, and refuses to preview applied or reverted history', async () => {
    const draft = (await tool('venues.get_preview_link').handler(
      { ...base, releaseKind: 'PACKAGE_DRAFT', releaseId: 'pkg_1' },
      context(),
    )) as any
    const claims = verifyGuestPreviewToken({
      secret: SECRET,
      token: new URL(draft.url).searchParams.get('token')!,
      now: NOW,
    })
    expect(claims).toMatchObject({ kind: 'package', versionId: 'pkg_1' })
    const history = (await tool('venues.get_preview_link').handler(
      { ...base, releaseKind: 'PACKAGE_DRAFT', releaseId: 'pkg_applied' },
      context(),
    )) as any
    expect(history.url).toBeNull()
    expect(history.unavailable.code).toBe('PACKAGE_NOT_REVIEWABLE')
  })

  it('fails closed without a signing secret or a guest origin, and mints nothing', async () => {
    vi.stubEnv('GUEST_PREVIEW_SIGNING_SECRET', '')
    const noSecret = (await tool('venues.get_preview_link').handler(
      { ...base, releaseKind: 'NATIVE_RELEASE', releaseId: 'rel_1' },
      context(),
    )) as any
    expect(noSecret).toMatchObject({
      url: null,
      unavailable: { code: 'PREVIEW_SIGNING_NOT_CONFIGURED' },
    })
    vi.stubEnv('GUEST_PREVIEW_SIGNING_SECRET', SECRET)
    vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'http://insecure.example.com')
    const noOrigin = (await tool('venues.get_preview_link').handler(
      { ...base, releaseKind: 'NATIVE_RELEASE', releaseId: 'rel_1' },
      context(),
    )) as any
    expect(noOrigin.unavailable.code).toBe('GUEST_ORIGIN_NOT_CONFIGURED')
  })

  it('treats another tenant, another venue and a foreign release as not found', async () => {
    await expect(
      tool('venues.get_preview_link').handler(
        { ...base, releaseKind: 'NATIVE_RELEASE', releaseId: 'rel_1' },
        context(['tenant_z']),
      ),
    ).rejects.toBeInstanceOf(OperatorNotFoundError)
    await expect(
      tool('venues.get_preview_link').handler(
        { tenantId: TENANT, venueId: 'venue_b', releaseKind: 'NATIVE_RELEASE', releaseId: 'rel_1' },
        context(),
      ),
    ).rejects.toBeInstanceOf(OperatorNotFoundError)
    releases.push({ ...releases[0], id: 'rel_foreign', venueId: 'venue_b' })
    await expect(
      tool('venues.get_preview_link').handler(
        { ...base, releaseKind: 'NATIVE_RELEASE', releaseId: 'rel_foreign' },
        context(),
      ),
    ).rejects.toBeInstanceOf(OperatorNotFoundError)
  })
})

describe('release reads stay inside the grant', () => {
  it.each([
    ['venues.list_releases', {}],
    ['venues.get_release', { releaseKind: 'NATIVE_RELEASE', releaseId: 'rel_1' }],
    ['venues.get_effective_guest_version', {}],
    ['venues.get_release_preflight', {}],
    ['venues.list_content', { representation: 'LEGACY_KNOWLEDGE' }],
    ['venues.get_content', { representation: 'LEGACY_KNOWLEDGE', id: 'k_1' }],
    [
      'venues.preview_content_changeset',
      {
        ops: [
          { op: 'retire', representation: 'LEGACY_KNOWLEDGE', id: 'k_1', expectedRevision: '1' },
        ],
      },
    ],
  ])('%s is not found outside the grant and reads nothing', async (name, extra) => {
    native.snapshot.mockClear()
    await expect(
      tool(name).handler({ ...base, ...extra }, context(['tenant_z'])),
    ).rejects.toBeInstanceOf(OperatorNotFoundError)
    expect(native.snapshot).not.toHaveBeenCalled()
  })
})
