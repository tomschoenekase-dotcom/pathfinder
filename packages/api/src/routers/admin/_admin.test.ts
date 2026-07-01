import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  tenantFindMany,
  tenantFindUnique,
  tenantCreate,
  tenantUpdate,
  weeklyDigestFindUnique,
  weeklyDigestCreate,
  visitorSessionCount,
  visitorSessionFindMany,
  messageCount,
  questionClusterFindMany,
  userUpsert,
  tenantMembershipUpsert,
  writeAuditLogMock,
  enqueueWeeklyDigest,
} = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantCreate: vi.fn(),
  tenantUpdate: vi.fn(),
  weeklyDigestFindUnique: vi.fn(),
  weeklyDigestCreate: vi.fn(),
  visitorSessionCount: vi.fn(),
  visitorSessionFindMany: vi.fn(),
  messageCount: vi.fn(),
  questionClusterFindMany: vi.fn(),
  userUpsert: vi.fn(),
  tenantMembershipUpsert: vi.fn(),
  writeAuditLogMock: vi.fn(),
  enqueueWeeklyDigest: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    tenant: {
      findMany: tenantFindMany,
      findUnique: tenantFindUnique,
      create: tenantCreate,
      update: tenantUpdate,
    },
    weeklyDigest: {
      findUnique: weeklyDigestFindUnique,
      create: weeklyDigestCreate,
    },
    visitorSession: {
      count: visitorSessionCount,
      findMany: visitorSessionFindMany,
    },
    message: {
      count: messageCount,
    },
    questionCluster: {
      findMany: questionClusterFindMany,
    },
    user: {
      upsert: userUpsert,
    },
    tenantMembership: {
      upsert: tenantMembershipUpsert,
    },
  },
  writeAuditLog: writeAuditLogMock,
  withTenantIsolationBypass: async <T>(fn: () => Promise<T>) => fn(),
}))

vi.mock('@pathfinder/jobs', () => ({
  enqueueWeeklyDigest,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminRouter } from './_admin'

const baseCtx = {
  db: {} as TRPCContext['db'],
  headers: new Headers(),
}

function adminCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'admin_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin: true,
    },
  }
}

function nonAdminCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_1',
      activeTenantId: 'tenant_1',
      role: 'OWNER',
      isPlatformAdmin: false,
    },
  }
}

const testRouter = router({ admin: adminRouter })

describe('admin router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('admin.triggerDigest creates a digest for the current week and enqueues it', async () => {
    tenantFindUnique.mockResolvedValueOnce({ id: 'tenant_1' })
    weeklyDigestFindUnique.mockResolvedValueOnce(null)
    weeklyDigestCreate.mockResolvedValueOnce({ id: 'digest_1' })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.triggerDigest({ tenantId: 'tenant_1' })

    expect(result).toEqual({ digestId: 'digest_1' })
    expect(weeklyDigestCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          status: 'PENDING',
        }),
      }),
    )
    expect(enqueueWeeklyDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        digestId: 'digest_1',
      }),
    )
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.digest.triggered',
        actorId: 'admin_1',
        targetId: 'digest_1',
      }),
    )
  })

  it('admin.triggerDigest reuses the current week digest when one already exists', async () => {
    tenantFindUnique.mockResolvedValueOnce({ id: 'tenant_1' })
    weeklyDigestFindUnique.mockResolvedValueOnce({ id: 'digest_existing' })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.triggerDigest({ tenantId: 'tenant_1' })

    expect(result).toEqual({ digestId: 'digest_existing' })
    expect(weeklyDigestCreate).not.toHaveBeenCalled()
    expect(enqueueWeeklyDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        digestId: 'digest_existing',
      }),
    )
  })

  it('admin.triggerDigest throws NOT_FOUND when the tenant does not exist', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(adminCtx())

    await expect(caller.admin.triggerDigest({ tenantId: 'missing_tenant' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })

  it('admin.triggerDigest throws FORBIDDEN for non-admin users', async () => {
    const caller = testRouter.createCaller(nonAdminCtx())

    await expect(caller.admin.triggerDigest({ tenantId: 'tenant_1' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }),
    )
  })

  it('admin.getClientAnalytics returns tenant stats, clusters, and recent sessions', async () => {
    const startedAt = new Date('2026-07-01T12:00:00.000Z')
    const messageCreatedAt = new Date('2026-07-01T12:01:00.000Z')
    const windowStart = new Date('2026-06-30T00:00:00.000Z')

    tenantFindUnique.mockResolvedValueOnce({
      id: 'tenant_1',
      name: 'Tenant One',
      slug: 'tenant-one',
    })
    visitorSessionCount.mockResolvedValueOnce(3)
    messageCount.mockResolvedValueOnce(8)
    visitorSessionFindMany
      .mockResolvedValueOnce([{ visitorId: 'visitor_1' }, { visitorId: 'visitor_2' }])
      .mockResolvedValueOnce([
        {
          id: 'session_1',
          startedAt,
          lastActiveAt: startedAt,
          messageCount: 2,
          visitorId: 'visitor_1',
          messages: [
            {
              id: 'message_1',
              role: 'user',
              content: 'Where are the bathrooms?',
              createdAt: messageCreatedAt,
              topic: 'amenities',
            },
          ],
        },
      ])
    questionClusterFindMany.mockResolvedValueOnce([
      {
        id: 'cluster_1',
        kind: 'top_question',
        canonicalText: 'Where are the bathrooms?',
        count: 4,
        examples: [],
        windowStart,
        venue: { name: 'Main Venue' },
      },
    ])

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.getClientAnalytics({ tenantId: 'tenant_1' })

    expect(result.stats).toEqual({
      totalSessions: 3,
      totalMessages: 8,
      uniqueVisitors: 2,
    })
    expect(result.tenant.name).toBe('Tenant One')
    expect(result.recentSessions).toHaveLength(1)
    expect(result.questionClusters).toHaveLength(1)
    expect(visitorSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: ['visitorId'],
      }),
    )
  })

  it('admin.getClientAnalytics throws NOT_FOUND when the tenant does not exist', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)
    visitorSessionCount.mockResolvedValueOnce(0)
    messageCount.mockResolvedValueOnce(0)
    visitorSessionFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    questionClusterFindMany.mockResolvedValueOnce([])

    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.getClientAnalytics({ tenantId: 'missing_tenant' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
  })
})
