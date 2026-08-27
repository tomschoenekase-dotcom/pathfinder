import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  place: vi.fn(),
  knowledge: vi.fn(),
  update: vi.fn(),
  confirm: vi.fn(),
}))
vi.mock('@pathfinder/db', () => ({
  ContentHumanReviewError: class ContentHumanReviewError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  confirmContentCurrentAction: mocks.confirm,
  withTenantIsolationBypass: mocks.bypass,
  db: {
    place: { findMany: mocks.place },
    venueKnowledgeEntry: { findMany: mocks.knowledge },
    operationalUpdate: { findMany: mocks.update },
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminFreshnessAuditRouter } from './freshness-audit'

const testRouter = router({ freshness: adminFreshnessAuditRouter })
function context(admin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'operator', activeTenantId: 'other', role: 'STAFF', isPlatformAdmin: admin },
  }
}

describe('admin freshness audit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.place.mockResolvedValue([])
    mocks.knowledge.mockResolvedValue([])
    mocks.update.mockResolvedValue([])
    mocks.confirm.mockResolvedValue({
      entityType: 'PLACE',
      entityId: 'place_1',
      conclusion: 'CONFIRMED_CURRENT',
      reviewedAt: new Date('2026-08-11T14:30:00.000Z'),
      updatedAt: new Date('2026-08-11T14:30:00.000Z'),
      repairedFields: [],
    })
  })

  it('rejects non-admin access before bypass', async () => {
    await expect(
      testRouter.createCaller(context(false)).freshness.listFreshnessAudit({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        queue: 'STALE_TRUSTED',
        entityType: 'PLACE',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
  })

  it('scopes stale trusted records and returns no source bodies', async () => {
    await testRouter.createCaller(context()).freshness.listFreshnessAudit({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      queue: 'STALE_TRUSTED',
      entityType: 'PLACE',
      thresholdDays: 60,
      limit: 10,
    })
    expect(mocks.place).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          isActive: true,
          humanConfirmedAt: { not: null },
          lastReviewedAt: { lte: expect.any(Date) },
        }),
        take: 11,
        select: expect.not.objectContaining({
          longDescription: expect.anything(),
          shortDescription: expect.anything(),
        }),
      }),
    )
  })

  it('scopes date-sensitive updates and paginates by expiry', async () => {
    mocks.update.mockResolvedValue([
      {
        id: 'expired',
        title: 'Past closure',
        startsAt: new Date('2020-01-01T00:00:00.000Z'),
        expiresAt: new Date('2020-01-02T00:00:00.000Z'),
      },
      {
        id: 'live',
        title: 'Current closure',
        startsAt: new Date('2020-01-01T00:00:00.000Z'),
        expiresAt: new Date('2090-01-02T00:00:00.000Z'),
      },
      {
        id: 'scheduled',
        title: 'Future closure',
        startsAt: new Date('2090-01-01T00:00:00.000Z'),
        expiresAt: new Date('2090-01-02T00:00:00.000Z'),
      },
    ])
    const result = await testRouter.createCaller(context()).freshness.listFreshnessAudit({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      queue: 'DATE_SENSITIVE',
      cursor: { sortAt: '2026-08-11T12:00:00.000Z', id: 'update_1' },
    })
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          status: 'PUBLISHED',
          isActive: true,
          expiresAt: { lte: expect.any(Date) },
          AND: [
            {
              OR: [
                { expiresAt: { gt: new Date('2026-08-11T12:00:00.000Z') } },
                { expiresAt: new Date('2026-08-11T12:00:00.000Z'), id: { gt: 'update_1' } },
              ],
            },
          ],
        }),
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      }),
    )
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'expired',
        temporalState: 'EXPIRED',
        guestVisibleNow: false,
        cleanupPending: true,
      }),
      expect.objectContaining({
        id: 'live',
        temporalState: 'LIVE',
        guestVisibleNow: true,
        cleanupPending: false,
      }),
      expect.objectContaining({
        id: 'scheduled',
        temporalState: 'SCHEDULED',
        guestVisibleNow: false,
        cleanupPending: false,
      }),
    ])
  })

  it('requires content entity type but rejects one for update windows', async () => {
    await expect(
      testRouter.createCaller(context()).freshness.listFreshnessAudit({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        queue: 'PROVENANCE_GAP',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      testRouter.createCaller(context()).freshness.listFreshnessAudit({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        queue: 'DATE_SENSITIVE',
        entityType: 'PLACE',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects non-admin confirmation before the domain action', async () => {
    await expect(
      testRouter.createCaller(context(false)).freshness.confirmFreshnessCurrent({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        entityType: 'PLACE',
        entityId: 'place_1',
        expectedUpdatedAt: new Date('2026-08-10T10:00:00.000Z'),
        conclusion: 'CONFIRMED_CURRENT',
        explicitlyConfirmedCurrent: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  it('binds the signed-in human platform admin to an exact scoped CAS review', async () => {
    const expectedUpdatedAt = new Date('2026-08-10T10:00:00.000Z')
    await testRouter.createCaller(context()).freshness.confirmFreshnessCurrent({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      entityType: 'KNOWLEDGE_ENTRY',
      entityId: 'knowledge_1',
      expectedUpdatedAt,
      conclusion: 'CONFIRMED_CURRENT',
      explicitlyConfirmedCurrent: true,
      provenanceRepair: { sourceType: 'DOCUMENT', sourceName: 'Operations guide' },
    })
    expect(mocks.confirm).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      entityType: 'KNOWLEDGE_ENTRY',
      entityId: 'knowledge_1',
      expectedUpdatedAt,
      conclusion: 'CONFIRMED_CURRENT',
      explicitlyConfirmedCurrent: true,
      provenanceRepair: { sourceType: 'DOCUMENT', sourceName: 'Operations guide' },
      actor: { type: 'HUMAN', id: 'operator', role: 'PLATFORM_ADMIN' },
    })
  })
})
