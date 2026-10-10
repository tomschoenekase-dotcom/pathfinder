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

  it('keeps the failing step and its reason on the receipt', async () => {
    mocks.approve.mockRejectedValue(
      new TRPCError({ code: 'CONFLICT', message: 'Venue package changed' }),
    )
    const failure = await venuesPackageImportKind.apply(args(), context).catch((error) => error)
    expect(failure.code).toBe('CONFLICT')
    expect(failure.summary).toBe(
      'The approve step failed (CONFLICT): Venue package changed. Nothing was applied. Retry with a new operationId; the saved draft stays unapplied.',
    )
    expect(mocks.apply).not.toHaveBeenCalled()
  })
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
    expect(failure.summary).toContain('The revert step failed (CONFLICT): A newer venue package')

    await expect(
      venuesPackageImportKind.revert!(original(null), revertContext(null)),
    ).rejects.toThrow('no applied package')
    await expect(venuesPackageImportKind.revert!(original(), revertContext(null))).rejects.toThrow()
  })
})

describe('venues.check_package', () => {
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

  it('names schema problems instead of throwing', async () => {
    const result: any = await venuesCheckPackage.handler(
      { tenantId: TENANT, venueId: VENUE, payload: { schemaVersion: 3, places: 'nope' } },
      context,
    )
    expect(result.importable).toBe(false)
    expect(result.errorCount).toBeGreaterThan(0)
    expect(result.errors[0].code).toBe('INVALID_PACKAGE')
    expect(OPERATOR_MCP_OUTPUTS['venues.check_package'].safeParse(result).success).toBe(true)
    expect(mocks.preview).not.toHaveBeenCalled()
  })
})
