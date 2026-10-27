/* eslint-disable @typescript-eslint/no-explicit-any -- loose fakes for the lifecycle surface */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  draft: vi.fn(),
  approve: vi.fn(),
  apply: vi.fn(),
  revert: vi.fn(),
  preview: vi.fn(),
  assertVenueInGrant: vi.fn(),
}))

vi.mock('../../routers/venue-package', () => ({ createVenuePackageDraftService: mocks.draft }))
vi.mock('../../lib/venue-package-core', () => ({
  approveVenuePackageLifecycle: mocks.approve,
  applyVenuePackageLifecycle: mocks.apply,
  revertVenuePackageLifecycle: mocks.revert,
  buildVenuePackagePreview: mocks.preview,
}))
vi.mock('../grants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../grants')>()),
  assertVenueInGrant: mocks.assertVenueInGrant,
}))

import { TRPCError } from '@trpc/server'
import { OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'

import { venuesCheckPackage } from '../tools/venue-package-check'
import { venuesPackageImportKind } from './venues-package-import'

const TENANT = 'tenant-a'
const VENUE = 'venue-a'
const payload = {
  schemaVersion: 3,
  places: { create: [], update: [], delete: [] },
  knowledgeEntries: {
    create: [
      {
        itemKey: '11111111-1111-4111-a111-111111111111',
        provenance: {
          sourceType: 'manual',
          sourceName: 'Venue team',
          contentOrigin: 'HUMAN_AUTHORED',
        },
        value: { title: 'Hours', category: 'Hours', content: 'Open 10am-6pm daily.' },
      },
    ],
    update: [],
    delete: [],
  },
}
const report = (warnings: Array<{ code: string; path: string; message: string }> = []) => ({
  errors: [],
  warnings,
  semanticDuplicateScan: { status: 'COMPLETE' },
})
const context = {
  database: {
    $transaction: (run: (tx: unknown) => unknown) => run({}),
    venue: {
      findFirst: async () => ({
        guideMode: 'non_location',
        chatAppearance: { timeZone: 'America/Chicago' },
      }),
    },
    place: { count: async () => 0 },
  },
  grant: {},
  now: new Date('2026-10-07T12:00:00.000Z'),
  actor: { type: 'HUMAN', id: 'user-1', role: 'PLATFORM_ADMIN' },
  proposalId: 'proposal-1',
  operationId: '8a1f1c0e-2f87-4b5e-9d57-6a2b6d7a9d10',
} as any

beforeEach(() => {
  vi.clearAllMocks()
  mocks.draft.mockResolvedValue({
    value: {
      id: 'pkg-1',
      status: 'DRAFT',
      updatedAt: new Date('2026-10-07T12:00:00.000Z'),
      preview: { report: report(), payloadHash: 'p', warningDigest: 'w' },
    },
  })
  mocks.approve.mockResolvedValue({ id: 'pkg-1', status: 'APPROVED', updatedAt: new Date() })
  mocks.apply.mockResolvedValue({ id: 'pkg-1', status: 'APPLIED' })
})

describe('venues.propose_package_import apply', () => {
  const args = () =>
    venuesPackageImportKind.parse({
      tenantId: TENANT,
      venueId: VENUE,
      payload,
      operationId: context.operationId,
    })

  it('applies and reports the plan and guide quality', async () => {
    const outcome = await venuesPackageImportKind.apply(args(), context)
    expect(outcome.result).toMatchObject({
      status: 'APPLIED',
      guideQuality: { total: 0 },
      plan: { knowledgeEntries: { create: 1 } },
    })
  })

  it.each([
    { code: 'CONFLICT', longReason: false },
    { code: 'CONFLICT', longReason: true },
    { code: 'P2028', longReason: false },
    { code: 'P2028', longReason: true },
  ])(
    'retains receipt recovery for $code with longReason=$longReason',
    async ({ code, longReason }) => {
      const reason = longReason
        ? `Venue package changed: ${'detail '.repeat(200)}`
        : 'Venue package changed'
      const error =
        code === 'CONFLICT'
          ? new TRPCError({ code: 'CONFLICT', message: reason })
          : Object.assign(new Error(reason), { code })
      mocks.approve.mockRejectedValue(error)
      const failure = await venuesPackageImportKind.apply(args(), context).catch((error) => error)
      expect(failure.code).toBe(code)
      expect(failure.summary).toContain(
        `The approve step failed (${code}). Retain the original operationId and exact content; inspect operator.get_operation and the package receipt. Do not use a new operationId without no-effect proof.`,
      )
      expect(failure.summary).toContain('Reason: Venue package changed')
      expect(failure.summary.length).toBeLessThanOrEqual(500)
      expect(failure.summary).not.toContain('Retry with a new operationId')
      expect(failure.summary).not.toContain('Nothing was applied.')
      expect(mocks.apply).not.toHaveBeenCalled()
    },
  )
})

describe('venues.propose_package_import revert', () => {
  const packageUpdatedAt = new Date('2026-10-07T12:05:00.000Z')
  const original = (afterSnapshot: unknown = { packageId: 'pkg-1', status: 'APPLIED' }) =>
    ({
      id: 'proposal-0',
      kind: 'venues.package-import',
      status: 'APPLIED',
      targetTenantId: TENANT,
      targetVenueId: VENUE,
      afterSnapshot,
    }) as any
  const revertContext = (found: unknown) => ({
    ...context,
    operationId: '9b2e2d1f-3a98-4c6f-8e68-7b3c7e8b0e21',
    database: {
      ...context.database,
      venuePackage: { findFirst: vi.fn().mockResolvedValue(found) },
    },
  })

  it('reverts the applied package through the package lifecycle in one transaction', async () => {
    mocks.revert.mockResolvedValue({ id: 'pkg-1', status: 'REVERTED' })
    const ctx = revertContext({ id: 'pkg-1', updatedAt: packageUpdatedAt })
    const outcome = await venuesPackageImportKind.revert!(original(), ctx)

    expect(ctx.database.venuePackage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pkg-1', tenantId: TENANT, venueId: VENUE } }),
    )
    expect(mocks.revert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        venueId: VENUE,
        command: expect.objectContaining({ id: 'pkg-1', expectedUpdatedAt: packageUpdatedAt }),
      }),
    )
    expect(outcome).toEqual({
      result: { venueId: VENUE, packageId: 'pkg-1', status: 'REVERTED' },
      after: { packageId: 'pkg-1', status: 'REVERTED' },
    })
  })

  it('uses a stable command key so a retried revert replays instead of reverting twice', async () => {
    mocks.revert.mockResolvedValue({ id: 'pkg-1', status: 'REVERTED' })
    const ctx = revertContext({ id: 'pkg-1', updatedAt: packageUpdatedAt })
    await venuesPackageImportKind.revert!(original(), ctx)
    await venuesPackageImportKind.revert!(original(), ctx)
    const keys = mocks.revert.mock.calls.map(([request]) => request.command.commandKey)
    expect(keys[0]).toBe(keys[1])
  })

  it('reports a stale revert with the step and reason, and refuses an import with no package', async () => {
    mocks.revert.mockRejectedValue(
      new TRPCError({ code: 'CONFLICT', message: 'A newer venue package was applied' }),
    )
    const failure = await venuesPackageImportKind.revert!(
      original(),
      revertContext({ id: 'pkg-1', updatedAt: packageUpdatedAt }),
    ).catch((error) => error)
    expect(failure.summary).toContain('The revert step failed (CONFLICT).')
    expect(failure.summary).toContain('Reason: A newer venue package was applied')

    await expect(
      venuesPackageImportKind.revert!(original(null), revertContext(null)),
    ).rejects.toThrow('no applied package')
    await expect(venuesPackageImportKind.revert!(original(), revertContext(null))).rejects.toThrow()
  })
})

describe('venues.check_package', () => {
  it.each([
    { code: 'DUPLICATE_IN_PACKAGE', ready: false },
    { code: 'SEMANTIC_DUPLICATE_IN_PACKAGE', ready: true },
  ])('keeps importability separate from readiness for $code', async ({ code, ready }) => {
    mocks.preview.mockResolvedValue({
      report: report([
        { code, path: 'knowledgeEntries.create.0.value.title', message: 'Duplicate' },
      ]),
    })
    const result: any = await venuesCheckPackage.handler(
      { tenantId: TENANT, venueId: VENUE, payload },
      context,
    )
    expect(result).toMatchObject({
      importable: true,
      ready,
      guideQuality: { total: 0 },
      otherWarningCount: 1,
    })
    expect(mocks.draft).not.toHaveBeenCalled()
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('reports plan, errors and guide-quality findings without saving anything', async () => {
    mocks.preview.mockResolvedValue({
      report: report([
        {
          code: 'GUIDE_QUALITY_TITLE',
          path: 'knowledgeEntries.create.0.value.title',
          message: 'x',
        },
        {
          code: 'DUPLICATE_IN_PACKAGE',
          path: 'knowledgeEntries.create.0.value.title',
          message: 'y',
        },
      ]),
    })
    const result: any = await venuesCheckPackage.handler(
      { tenantId: TENANT, venueId: VENUE, payload },
      context,
    )
    expect(result).toMatchObject({
      importable: true,
      ready: false,
      plan: { knowledgeEntries: { create: 1, update: 0, remove: 0 } },
      errorCount: 0,
      guideQuality: { total: 1 },
      otherWarningCount: 1,
    })
    expect(mocks.draft).not.toHaveBeenCalled()
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('names venue settings that change answers: missing time zone, location mode with no places', async () => {
    mocks.preview.mockResolvedValue({ report: report() })
    const database = {
      ...context.database,
      venue: { findFirst: async () => ({ guideMode: null, chatAppearance: {} }) },
      place: { count: async () => 0 },
    }
    const result: any = await venuesCheckPackage.handler(
      { tenantId: TENANT, venueId: VENUE, payload },
      { ...context, database },
    )
    expect(result.ready).toBe(true)
    expect(result.venueSetup.map((f: { code: string }) => f.code)).toEqual([
      'VENUE_SETUP_TIME_ZONE',
      'VENUE_SETUP_GUIDE_MODE',
    ])
    expect(OPERATOR_MCP_OUTPUTS['venues.check_package'].safeParse(result).success).toBe(true)
    const configured: any = await venuesCheckPackage.handler(
      { tenantId: TENANT, venueId: VENUE, payload },
      context,
    )
    expect(configured.venueSetup).toEqual([])
  })

  it.each([
    {
      label: 'deactivating the last active place',
      active: true,
      update: false,
      remove: false,
      empty: true,
    },
    {
      label: 'reactivating an inactive place',
      active: false,
      update: true,
      remove: false,
      empty: false,
    },
    {
      label: 'deleting an inactive place while another remains',
      active: false,
      update: null,
      remove: true,
      empty: false,
    },
    {
      label: 'replacing the last active place with a new place',
      active: true,
      update: null,
      remove: true,
      empty: false,
    },
  ])('projects active places after $label', async ({ active, update, remove, empty }) => {
    mocks.preview.mockResolvedValue({ report: report() })
    const targetId = 'cm00000000000000000000001'
    const remainingId = 'cm00000000000000000000002'
    const replacing = active && remove
    const existing = [
      { id: targetId, isActive: active },
      ...(remove && !active ? [{ id: remainingId, isActive: true }] : []),
    ]
    const count = vi.fn(
      async ({ where }: any) =>
        existing.filter((place) => place.isActive && !where.id?.notIn.includes(place.id)).length,
    )
    const database = {
      ...context.database,
      venue: {
        findFirst: async () => ({
          guideMode: 'location_aware',
          chatAppearance: { timeZone: 'America/Chicago' },
        }),
      },
      place: { count, findMany: async () => existing.map(({ id }) => ({ id })) },
    }
    const identity = {
      itemKey: '22222222-2222-4222-a222-222222222222',
      provenance: payload.knowledgeEntries.create[0]!.provenance,
    }
    const result: any = await venuesCheckPackage.handler(
      {
        tenantId: TENANT,
        venueId: VENUE,
        payload: {
          ...payload,
          places: {
            create: replacing
              ? [
                  {
                    ...identity,
                    value: { name: 'New gallery', type: 'gallery', lat: 41, lng: -87 },
                  },
                ]
              : [],
            update:
              update === null
                ? []
                : [
                    {
                      ...identity,
                      id: targetId,
                      value: {
                        name: 'Fictional gallery',
                        type: 'gallery',
                        itemType: 'room',
                        shortDescription: null,
                        longDescription: null,
                        lat: 41,
                        lng: -87,
                        tags: [],
                        importanceScore: 0,
                        areaName: null,
                        hours: null,
                        photoUrl: null,
                        isActive: update,
                      },
                    },
                  ],
            delete: remove
              ? [{ ...identity, itemKey: '33333333-3333-4333-a333-333333333333', id: targetId }]
              : [],
          },
        },
      },
      { ...context, database },
    )
    expect(result.ready).toBe(true)
    expect(result.venueSetup.some(({ code }: any) => code === 'VENUE_SETUP_GUIDE_MODE')).toBe(empty)
    expect(count).toHaveBeenCalledWith({
      where: { tenantId: TENANT, venueId: VENUE, isActive: true, id: { notIn: [targetId] } },
    })
    expect(mocks.draft).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('names schema problems instead of throwing', async () => {
    const result: any = await venuesCheckPackage.handler(
      { tenantId: TENANT, venueId: VENUE, payload: { schemaVersion: 3, places: 'nope' } },
      context,
    )
    expect(result.importable).toBe(false)
    expect(result.errorCount).toBeGreaterThan(0)
    // Each schema problem names its own code, the field and a fix (was one generic INVALID_PACKAGE).
    expect(result.errors[0]).toMatchObject({ code: 'WRONG_TYPE', path: 'places' })
    expect(result.errors[0].fix).toMatch(/places/u)
    expect(OPERATOR_MCP_OUTPUTS['venues.check_package'].safeParse(result).success).toBe(true)
    expect(mocks.preview).not.toHaveBeenCalled()
  })
})

describe('package-check polish regressions', () => {
  const targetId = 'cm00000000000000000000001'
  const identity = {
    itemKey: '22222222-2222-4222-a222-222222222222',
    provenance: payload.knowledgeEntries.create[0]!.provenance,
  }
  const desired = {
    name: 'Cloud Lantern',
    type: 'gallery',
    itemType: null,
    shortDescription: null,
    longDescription: null,
    lat: 41,
    lng: -87,
    tags: [],
    importanceScore: 0,
    areaName: null,
    hours: null,
    photoUrl: null,
    isActive: true,
  }
  const database = (places: any[] = []) => ({
    venue: {
      findFirst: async () => ({
        id: VENUE,
        name: 'Cloud Lantern Museum',
        guideMode: 'location_aware',
        aiFeaturedPlaceId: null,
        description: null,
        category: null,
        guideNotes: null,
        chatTheme: null,
        chatAccentColor: null,
        chatFont: null,
        chatLogoUrl: null,
        chatBannerUrl: null,
        aiGuideNotes: null,
        aiTone: null,
        aiGuideName: null,
        chatAppearance: { timeZone: 'America/Chicago' },
      }),
    },
    place: { findMany: async () => places, count: async () => 0 },
    venueKnowledgeEntry: { findMany: async () => [] },
    contentVersion: { groupBy: async () => [] },
    operationalUpdate: { groupBy: async () => [] },
    analyticsEvent: { groupBy: async () => [] },
    dailyRollup: { groupBy: async () => [] },
    venueLocation: { groupBy: async () => [] },
    venueMediaPlaceLink: { groupBy: async () => [] },
  })
  async function actualPreview(input: unknown, places: any[] = []) {
    const core = await vi.importActual<typeof import('../../lib/venue-package-core')>(
      '../../lib/venue-package-core',
    )
    const { VenuePackagePayload } = await import('../../schemas/venue-package')
    return core.buildVenuePackagePreview(
      database(places) as never,
      TENANT,
      VENUE,
      VenuePackagePayload.parse(input),
    )
  }
  it('does not collide distinct all-non-Latin place names or knowledge titles', async () => {
    const result = await actualPreview({
      schemaVersion: 1,
      places: ['雲灯', '星庭'].map((name) => ({ name, type: 'gallery', lat: 41, lng: -87 })),
      knowledgeEntries: ['開園', '入場'].map((title) => ({
        title,
        category: 'GENERAL',
        content: 'Fictional policy is unconfirmed.',
      })),
    })
    expect(result.report.warnings.filter(({ code }) => code === 'DUPLICATE_IN_PACKAGE')).toEqual([])
  })
  it('does not call delete-and-create replacement an existing-content duplicate', async () => {
    const result = await actualPreview(
      {
        ...payload,
        places: {
          create: [
            { ...identity, value: { name: 'Cloud Lantern', type: 'gallery', lat: 41, lng: -87 } },
          ],
          update: [],
          delete: [{ ...identity, itemKey: '33333333-3333-4333-a333-333333333333', id: targetId }],
        },
      },
      [{ id: targetId, ...desired }],
    )
    expect(
      result.report.warnings.filter(({ code }) => code === 'DUPLICATE_EXISTING_CONTENT'),
    ).toEqual([])
  })
  it('keeps missing update ids out of active-place advice', async () => {
    mocks.preview.mockResolvedValue({
      report: {
        ...report(),
        errors: [{ code: 'TARGET_NOT_FOUND', path: 'places.update.0', message: 'Missing target.' }],
      },
    })
    const result: any = await venuesCheckPackage.handler(
      {
        tenantId: TENANT,
        venueId: VENUE,
        payload: {
          ...payload,
          places: {
            create: [],
            delete: [],
            update: [{ ...identity, id: targetId, value: desired }],
          },
        },
      },
      { ...context, database: database() },
    )
    expect(result.importable).toBe(false)
    expect(result.venueSetup.some(({ code }: any) => code === 'VENUE_SETUP_GUIDE_MODE')).toBe(true)
    expect(result.note).toContain('warnings never block importable')
    expect(result.note).toContain('exact in-package duplicates block ready')
  })
})
