import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { analyticsRouter } from './analytics'

const weeklyDigestFindFirst = vi.fn()
const weeklyDigestFindMany = vi.fn()
const dailyRollupFindMany = vi.fn()
const analyticsEventCreate = vi.fn()
const guestSessionUpsert = vi.fn()
const guestSessionUpdateMany = vi.fn()
const dbQueryRaw = vi.fn()

const mockDb = {
  weeklyDigest: {
    findFirst: weeklyDigestFindFirst,
    findMany: weeklyDigestFindMany,
  },
  dailyRollup: {
    findMany: dailyRollupFindMany,
  },
  analyticsEvent: {
    create: analyticsEventCreate,
  },
  guestSession: {
    upsert: guestSessionUpsert,
    updateMany: guestSessionUpdateMany,
  },
  $queryRaw: dbQueryRaw,
} as unknown as TRPCContext['db']

const baseCtx = {
  db: mockDb,
  headers: new Headers(),
}

function tenantCtx(tenantId = 'tenant_1'): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_1',
      activeTenantId: tenantId,
      role: 'MANAGER',
      isPlatformAdmin: false,
    },
  }
}

function anonymousCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: null,
      activeTenantId: null,
      role: null,
      isPlatformAdmin: false,
    },
  }
}

const testRouter = router({ analytics: analyticsRouter })

describe('analytics router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('analytics.getLatestDigest returns the latest complete digest for the active tenant', async () => {
    const digest = {
      id: 'digest_1',
      weekStart: new Date('2026-04-06T00:00:00.000Z'),
      weekEnd: new Date('2026-04-12T23:59:59.999Z'),
      status: 'COMPLETE',
      sessionCount: 12,
      messageCount: 87,
      insights: [],
      generatedAt: new Date('2026-04-13T04:00:00.000Z'),
      createdAt: new Date('2026-04-13T04:00:00.000Z'),
    }
    weeklyDigestFindFirst.mockResolvedValueOnce(digest)

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.analytics.getLatestDigest()

    expect(result).toEqual(digest)
    expect(weeklyDigestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant_1',
          status: 'COMPLETE',
        },
      }),
    )
  })

  it('analytics.getLatestDigest throws UNAUTHORIZED without a session', async () => {
    const caller = testRouter.createCaller(anonymousCtx())

    await expect(caller.analytics.getLatestDigest()).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'UNAUTHORIZED' }),
    )
  })

  it('analytics.listDigests returns the latest digest summaries for the active tenant', async () => {
    const digests = [
      {
        id: 'digest_1',
        weekStart: new Date('2026-04-06T00:00:00.000Z'),
        weekEnd: new Date('2026-04-12T23:59:59.999Z'),
        status: 'COMPLETE',
        sessionCount: 12,
        messageCount: 87,
        generatedAt: new Date('2026-04-13T04:00:00.000Z'),
      },
    ]
    weeklyDigestFindMany.mockResolvedValueOnce(digests)

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.analytics.listDigests()

    expect(result).toEqual(digests)
    expect(weeklyDigestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant_1',
        },
        take: 8,
      }),
    )
  })

  it('analytics.listDigests throws UNAUTHORIZED without a session', async () => {
    const caller = testRouter.createCaller(anonymousCtx())

    await expect(caller.analytics.listDigests()).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'UNAUTHORIZED' }),
    )
  })

  it('analytics.getDigest returns the full digest for the active tenant', async () => {
    const digest = {
      id: 'digest_1',
      weekStart: new Date('2026-04-06T00:00:00.000Z'),
      weekEnd: new Date('2026-04-12T23:59:59.999Z'),
      status: 'COMPLETE',
      sessionCount: 12,
      messageCount: 87,
      insights: [
        {
          type: 'trend',
          title: 'Guests asked about feedings',
          body: 'Feeding times came up often.',
        },
      ],
      generatedAt: new Date('2026-04-13T04:00:00.000Z'),
      createdAt: new Date('2026-04-13T04:00:00.000Z'),
    }
    weeklyDigestFindFirst.mockResolvedValueOnce(digest)

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.analytics.getDigest({ id: 'digest_1' })

    expect(result).toEqual(digest)
    expect(weeklyDigestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'digest_1',
          tenantId: 'tenant_1',
        },
      }),
    )
  })

  it('analytics.getDigest treats a different-tenant digest as not found', async () => {
    weeklyDigestFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(tenantCtx())

    await expect(caller.analytics.getDigest({ id: 'digest_other_tenant' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })

  it('analytics.getDailyStats returns DailyRollup rows for the requested window', async () => {
    const rollups = [
      {
        id: 'rollup_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        date: new Date('2026-04-12T00:00:00.000Z'),
        metric: 'sessions',
        placeId: null,
        category: null,
        value: 24,
      },
    ]
    dailyRollupFindMany.mockResolvedValueOnce(rollups)

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.analytics.getDailyStats({ days: 30 })

    expect(result).toEqual(rollups)
    expect(dailyRollupFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          date: expect.objectContaining({
            gte: expect.any(Date),
          }),
        }),
      }),
    )
  })

  it('analytics.getDailyStats throws UNAUTHORIZED without a session', async () => {
    const caller = testRouter.createCaller(anonymousCtx())

    await expect(caller.analytics.getDailyStats({ days: 30 })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'UNAUTHORIZED' }),
    )
  })
})
