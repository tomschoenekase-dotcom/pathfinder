import { createHash } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/db', () => ({
  lockVenueContentMutation: vi.fn().mockResolvedValue(undefined),
  setContentVersionContext: vi.fn().mockResolvedValue(undefined),
  writeAuditLogStrict: vi.fn().mockResolvedValue(undefined),
}))

import { setContentVersionContext, writeAuditLogStrict } from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { canonicalVenuePackagePayload } from '../schemas/venue-package'
import { venuePackageRouter } from './venue-package'

const venueFindFirst = vi.fn()
const placeFindMany = vi.fn()
const placeCreateManyAndReturn = vi.fn()
const placeDeleteMany = vi.fn()
const knowledgeFindMany = vi.fn()
const knowledgeCreateManyAndReturn = vi.fn()
const knowledgeDeleteMany = vi.fn()
const packageFindFirst = vi.fn()
const packageFindMany = vi.fn()
const packageCreateMany = vi.fn()
const packageUpdateMany = vi.fn()
const auditLogCreate = vi.fn()

const mockDb = {
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(mockDb)),
  venue: { findFirst: venueFindFirst },
  place: {
    findMany: placeFindMany,
    createManyAndReturn: placeCreateManyAndReturn,
    deleteMany: placeDeleteMany,
  },
  venueKnowledgeEntry: {
    findMany: knowledgeFindMany,
    createManyAndReturn: knowledgeCreateManyAndReturn,
    deleteMany: knowledgeDeleteMany,
  },
  venuePackage: {
    findFirst: packageFindFirst,
    findMany: packageFindMany,
    createMany: packageCreateMany,
    updateMany: packageUpdateMany,
  },
  auditLog: { create: auditLogCreate },
} as unknown as TRPCContext['db']

const testRouter = router({ venuePackage: venuePackageRouter })
const venueId = 'cvenueabc123456789012'
const packageId = 'cpackageabc1234567890'
const updatedAt = new Date('2030-01-01T00:00:00.000Z')
const draftKey = '11111111-1111-4111-8111-111111111111'
const commandKey = '22222222-2222-4222-8222-222222222222'
const payload = {
  schemaVersion: 1 as const,
  places: [],
  knowledgeEntries: [
    { title: 'Accessibility', category: 'FAQ', content: 'Step-free entry.', isEnabled: true },
  ],
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

const emptyBaseDigest = digest({ places: [], knowledgeEntries: [] })
const emptyWarningDigest = digest([])
const basePackage = {
  id: packageId,
  tenantId: 'tenant_1',
  venueId,
  draftKey,
  schemaVersion: 1,
  payload,
  payloadHash: digest(canonicalVenuePackagePayload(venueId, payload)),
  baseDigest: emptyBaseDigest,
  validationReport: { errors: [], warnings: [] },
  previewPlan: {},
  status: 'DRAFT' as const,
  createdBy: 'user_manager',
  approvedBy: null,
  approvedAt: null,
  approvedCommandKey: null,
  approvalWarningDigest: null,
  approvedWarningCodes: null,
  appliedBy: null,
  appliedAt: null,
  appliedCommandKey: null,
  appliedEntities: null,
  revertedBy: null,
  revertedAt: null,
  revertedCommandKey: null,
  createdAt: updatedAt,
  updatedAt,
}

function context(role: 'STAFF' | 'MANAGER' | 'OWNER'): TRPCContext {
  return {
    db: mockDb,
    headers: new Headers(),
    session: {
      userId: `user_${role.toLowerCase()}`,
      activeTenantId: 'tenant_1',
      role,
      isPlatformAdmin: false,
    },
  }
}

describe('venue package router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    venueFindFirst.mockResolvedValue({ id: venueId, guideMode: 'non_location' })
    placeFindMany.mockResolvedValue([])
    knowledgeFindMany.mockResolvedValue([])
  })

  it('denies STAFF preview before any database access', async () => {
    await expect(
      testRouter.createCaller(context('STAFF')).venuePackage.preview({ venueId, payload }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    expect(venueFindFirst).not.toHaveBeenCalled()
  })

  it('returns a server-authoritative additive preview with deterministic duplicate warnings', async () => {
    knowledgeFindMany.mockResolvedValueOnce([
      {
        id: 'cknowledgeabc123456789',
        title: '  ACCESSIBILITY ',
        category: 'FAQ',
        content: 'Existing',
        isEnabled: true,
      },
    ])
    const result = await testRouter
      .createCaller(context('MANAGER'))
      .venuePackage.preview({ venueId, payload })

    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: 'ADDITIVE_V1',
      report: {
        errors: [],
        warnings: [
          expect.objectContaining({
            code: 'DUPLICATE_EXISTING_CONTENT',
            path: 'knowledgeEntries.0.title',
          }),
        ],
      },
      changes: { knowledgeEntries: { add: payload.knowledgeEntries, change: [], remove: [] } },
    })
    expect(packageCreateMany).not.toHaveBeenCalled()
  })

  it('persists a validated immutable draft and audits only the winning claim', async () => {
    packageCreateMany.mockResolvedValueOnce({ count: 1 })
    packageFindFirst.mockResolvedValueOnce(basePackage).mockResolvedValueOnce(basePackage)

    const result = await testRouter
      .createCaller(context('MANAGER'))
      .venuePackage.createDraft({ venueId, payload, draftKey })

    expect(result).toMatchObject({ id: packageId, status: 'DRAFT', replayed: false })
    expect(packageCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            tenantId: 'tenant_1',
            venueId,
            schemaVersion: 1,
            baseDigest: emptyBaseDigest,
          }),
        ],
        skipDuplicates: true,
      }),
    )
    expect(setContentVersionContext).toHaveBeenCalledWith(mockDb, { actorId: 'user_manager' })
    expect(writeAuditLogStrict).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'venue-package.created-draft', targetId: packageId }),
      mockDb,
    )
  })

  it('blocks approval when venue content drifted after preview', async () => {
    packageFindFirst.mockResolvedValueOnce(basePackage).mockResolvedValueOnce(basePackage)
    placeFindMany.mockResolvedValueOnce([
      {
        id: 'cplaceabc123456789012',
        name: 'New row',
        type: 'room',
        itemType: null,
        shortDescription: null,
        longDescription: null,
        lat: null,
        lng: null,
        tags: [],
        importanceScore: 0,
        areaName: null,
        hours: null,
        photoUrl: null,
        isActive: true,
      },
    ])

    await expect(
      testRouter.createCaller(context('OWNER')).venuePackage.approve({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
        acknowledgedWarningDigest: emptyWarningDigest,
        acknowledgedPayloadHash: basePackage.payloadHash,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(packageUpdateMany).not.toHaveBeenCalled()
    expect(writeAuditLogStrict).not.toHaveBeenCalled()
  })

  it('requires OWNER and a server-matching warning acknowledgement for approval', async () => {
    const warnedPayload = {
      ...payload,
      knowledgeEntries: [payload.knowledgeEntries[0]!, { ...payload.knowledgeEntries[0]! }],
    }
    const warnedPackage = {
      ...basePackage,
      payload: warnedPayload,
      payloadHash: digest(canonicalVenuePackagePayload(venueId, warnedPayload)),
    }

    await expect(
      testRouter.createCaller(context('MANAGER')).venuePackage.approve({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
        acknowledgedWarningDigest: '0'.repeat(64),
        acknowledgedPayloadHash: warnedPackage.payloadHash,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(packageFindFirst).not.toHaveBeenCalled()

    packageFindFirst.mockResolvedValueOnce(warnedPackage).mockResolvedValueOnce(warnedPackage)
    await expect(
      testRouter.createCaller(context('OWNER')).venuePackage.approve({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
        acknowledgedWarningDigest: '0'.repeat(64),
        acknowledgedPayloadHash: warnedPackage.payloadHash,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(packageUpdateMany).not.toHaveBeenCalled()
  })

  it('binds approval to the exact immutable payload hash shown to the owner', async () => {
    packageFindFirst.mockResolvedValueOnce(basePackage).mockResolvedValueOnce(basePackage)
    await expect(
      testRouter.createCaller(context('OWNER')).venuePackage.approve({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
        acknowledgedWarningDigest: emptyWarningDigest,
        acknowledgedPayloadHash: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(packageUpdateMany).not.toHaveBeenCalled()
  })

  it('atomically applies an approved package and records a rollback manifest', async () => {
    const approved = {
      ...basePackage,
      status: 'APPROVED' as const,
      approvedBy: 'user_manager',
      approvedAt: updatedAt,
      approvedCommandKey: commandKey,
      approvalWarningDigest: emptyWarningDigest,
      approvedWarningCodes: [],
    }
    const created = { id: 'cknowledgeabc123456789', ...payload.knowledgeEntries[0]! }
    const postState = { places: [], knowledgeEntries: [created] }
    const applied = {
      ...approved,
      status: 'APPLIED' as const,
      appliedBy: 'user_manager',
      appliedAt: updatedAt,
      appliedEntities: {
        postApplyDigest: digest(postState),
        places: [],
        knowledgeEntries: [created],
      },
    }
    packageFindFirst
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(applied)
    knowledgeFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([created])
    knowledgeCreateManyAndReturn.mockResolvedValueOnce([created])
    packageUpdateMany.mockResolvedValueOnce({ count: 1 })

    const result = await testRouter.createCaller(context('OWNER')).venuePackage.applyPackage({
      id: packageId,
      expectedUpdatedAt: updatedAt,
      commandKey,
    })

    expect(result.status).toBe('APPLIED')
    expect(knowledgeCreateManyAndReturn).toHaveBeenCalledOnce()
    expect(packageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'APPROVED', updatedAt }),
        data: expect.objectContaining({
          status: 'APPLIED',
          appliedEntities: expect.objectContaining({ postApplyDigest: digest(postState) }),
        }),
      }),
    )
    expect(writeAuditLogStrict).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'venue-package.applied' }),
      mockDb,
    )
  })

  it('refuses rollback after any venue-content drift and performs no delete', async () => {
    const appliedPackage = {
      ...basePackage,
      status: 'APPLIED',
      approvedBy: 'user_manager',
      approvedAt: updatedAt,
      appliedBy: 'user_manager',
      appliedAt: updatedAt,
      appliedCommandKey: commandKey,
      appliedEntities: {
        postApplyDigest: 'b'.repeat(64),
        places: [],
        knowledgeEntries: [],
      },
    }
    packageFindFirst.mockResolvedValueOnce(appliedPackage).mockResolvedValueOnce(appliedPackage)

    await expect(
      testRouter.createCaller(context('OWNER')).venuePackage.revertPackage({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(knowledgeDeleteMany).not.toHaveBeenCalled()
    expect(placeDeleteMany).not.toHaveBeenCalled()
    expect(packageUpdateMany).not.toHaveBeenCalled()
  })
})
