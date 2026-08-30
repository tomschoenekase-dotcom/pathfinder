import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminOffboardingPlansRouter } from './offboarding-plans'

const venueFindMany = vi.fn()
const planFindMany = vi.fn()
const planFindFirst = vi.fn()
const planCreate = vi.fn()
const auditCreate = vi.fn()
const tenantFindFirst = vi.fn()
const packageGroupBy = vi.fn()
const mockDb = {
  $executeRaw: vi.fn().mockResolvedValue(0),
  $transaction: vi.fn(async (callback: (tx: typeof mockDb) => unknown) => callback(mockDb)),
  venue: { findMany: venueFindMany },
  tenant: { findFirst: tenantFindFirst },
  venuePackage: { groupBy: packageGroupBy },
  offboardingPlan: { findMany: planFindMany, findFirst: planFindFirst, create: planCreate },
  auditLog: { create: auditCreate },
} as unknown as TRPCContext['db']

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: mockDb,
    headers: new Headers(),
    session: {
      userId: isPlatformAdmin ? 'platform-admin' : 'tenant-user',
      activeTenantId: 'tenant-session',
      role: 'OWNER',
      isPlatformAdmin,
    },
  }
}

const testRouter = router({ offboarding: adminOffboardingPlansRouter })
const requestedAt = new Date('2030-01-01T00:00:00.000Z')
const requestId = '11111111-1111-4111-8111-111111111111'

describe('admin offboarding plan foundation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    planFindMany.mockResolvedValue([])
    planFindFirst.mockResolvedValue(null)
    venueFindMany.mockResolvedValue([{ id: 'venue-1' }])
    tenantFindFirst.mockResolvedValue({
      id: 'tenant-1',
      status: 'ACTIVE',
      billingAccount: { status: 'ACTIVE' },
    })
    packageGroupBy.mockResolvedValue([])
    planCreate.mockResolvedValue({
      id: 'plan-1',
      tenantId: 'tenant-1',
      requestId,
      status: 'REQUESTED',
      requestedAt,
      revocationTargets: ['GUEST_LINKS'],
      exportKinds: [],
      _count: { venueTargets: 1 },
    })
    auditCreate.mockResolvedValue({ id: 'audit-1' })
  })

  it('rejects non-admin callers before any tenant data access', async () => {
    await expect(
      testRouter.createCaller(context(false)).offboarding.listOffboardingPlans({
        tenantId: 'tenant-1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(planFindMany).not.toHaveBeenCalled()
  })

  it('lists and reads with explicit tenant scope and stable bounded selects', async () => {
    await testRouter
      .createCaller(context())
      .offboarding.listOffboardingPlans({ tenantId: 'tenant-1' })
    expect(planFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1' },
        take: 26,
        select: expect.not.objectContaining({ revocationEvidence: expect.anything() }),
      }),
    )

    await expect(
      testRouter.createCaller(context()).offboarding.getOffboardingPlan({
        tenantId: 'tenant-2',
        planId: 'plan-from-tenant-1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(planFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'plan-from-tenant-1', tenantId: 'tenant-2' },
      }),
    )
  })

  it('creates only a requested draft after every venue passes exact tenant scope', async () => {
    await testRouter.createCaller(context()).offboarding.createOffboardingDraft({
      tenantId: 'tenant-1',
      requestId,
      venueIds: ['venue-1'],
      revocationTargets: ['GUEST_LINKS'],
      exportKinds: ['APPROVED_CONTENT'],
    })
    expect(venueFindMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', id: { in: ['venue-1'] } },
      select: { id: true },
    })
    expect(planCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenant: { connect: { id: 'tenant-1' } },
          requestId,
          requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          status: 'REQUESTED',
          requestedBy: 'platform-admin',
          venueTargets: {
            create: [
              {
                tenant: { connect: { id: 'tenant-1' } },
                venue: {
                  connect: { id_tenantId: { id: 'venue-1', tenantId: 'tenant-1' } },
                },
              },
            ],
          },
        }),
      }),
    )
    expect(planCreate.mock.calls[0]?.[0]?.data).not.toHaveProperty('deletionRequested')
    expect(auditCreate).toHaveBeenCalledTimes(1)
  })

  it('returns preserved venue state for human reactivation review without execution policy', async () => {
    tenantFindFirst.mockResolvedValue({
      id: 'tenant-1',
      status: 'ACTIVE',
      billingAccount: { status: 'ENDED' },
    })
    venueFindMany.mockResolvedValue([
      {
        id: 'venue-1',
        name: 'Harbor Museum',
        isActive: false,
        venueBotConfiguration: { id: 'bot-config-1' },
        _count: { places: 8, knowledgeEntries: 3, venuePackageManifestArtifacts: 1 },
      },
    ])
    packageGroupBy.mockResolvedValue([
      { venueId: 'venue-1', status: 'APPLIED', _count: { _all: 2 } },
    ])
    planFindMany.mockResolvedValue([
      {
        id: 'plan-1',
        status: 'COMPLETED',
        updatedAt: new Date('2026-08-22T00:00:00.000Z'),
        venueTargets: [
          {
            venueId: 'venue-1',
            revocationEvidence: [{ outcome: 'COMPLETE' }, { outcome: 'SKIPPED' }],
            exportArtifacts: [{ id: 'artifact-1' }],
          },
        ],
      },
    ])

    const result = await testRouter
      .createCaller(context())
      .offboarding.getCustomerStatePreservation({ tenantId: 'tenant-1' })

    expect(result).toMatchObject({
      schemaVersion: 'torchiko-customer-state-preservation-v1',
      evidenceBounded: false,
      policy: {
        automaticReactivationAuthorized: false,
        automaticCustomerContactAuthorized: false,
        retentionPolicy: 'UNRESOLVED',
        pauseFeePolicy: 'UNRESOLVED',
        reactivationFeePolicy: 'UNRESOLVED',
      },
      venues: [
        {
          reviewState: 'RESTORATION_REVIEW',
          operationalMaterialPreserved: true,
          material: {
            placeRecordCount: 8,
            knowledgeRecordCount: 3,
            packageRecordCount: 2,
            manifestRecordCount: 1,
            botConfigurationRecordPreserved: true,
            exportArtifactCount: 1,
          },
        },
      ],
    })
    expect(packageGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', venueId: { in: ['venue-1'] } },
      }),
    )
    expect(planFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          status: { not: 'CANCELLED' },
          venueTargets: { some: { venueId: { in: ['venue-1'] } } },
        },
        take: 101,
      }),
    )
  })

  it('does not create a plan when any requested venue is outside the tenant', async () => {
    venueFindMany.mockResolvedValue([])
    await expect(
      testRouter.createCaller(context()).offboarding.createOffboardingDraft({
        tenantId: 'tenant-1',
        requestId,
        venueIds: ['venue-from-tenant-2'],
        revocationTargets: ['CLIENT_ACCESS'],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(planCreate).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it('rolls an action error into the API boundary without exposing partial success', async () => {
    venueFindMany.mockResolvedValue([])
    await expect(
      testRouter.createCaller(context()).offboarding.createOffboardingDraft({
        tenantId: 'tenant-1',
        requestId,
        venueIds: ['missing-venue'],
        revocationTargets: ['CLIENT_ACCESS'],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(planCreate).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it('maps request identity collisions to a stable API conflict', async () => {
    planFindFirst.mockResolvedValue({
      id: 'plan-1',
      tenantId: 'tenant-1',
      requestId,
      requestHash: 'a'.repeat(64),
      requestedBy: 'another-admin',
      status: 'REQUESTED',
      requestedAt,
      _count: { venueTargets: 1 },
    })
    await expect(
      testRouter.createCaller(context()).offboarding.createOffboardingDraft({
        tenantId: 'tenant-1',
        requestId,
        venueIds: ['venue-1'],
        revocationTargets: ['CLIENT_ACCESS'],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(planCreate).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it('rejects duplicate scope and does not expose an execution or completion procedure', async () => {
    await expect(
      testRouter.createCaller(context()).offboarding.createOffboardingDraft({
        tenantId: 'tenant-1',
        requestId,
        venueIds: ['venue-1', 'venue-1'],
        revocationTargets: ['GUEST_LINKS'],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(planCreate).not.toHaveBeenCalled()
    expect(Object.keys(adminOffboardingPlansRouter._def.procedures).sort()).toEqual([
      'createOffboardingDraft',
      'getCustomerStatePreservation',
      'getOffboardingPlan',
      'listOffboardingPlans',
    ])
  })
})
