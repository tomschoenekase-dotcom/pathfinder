import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { analyticsRouter, loadPlaceInterestOverview } from './analytics'

const { checkRateLimitMock } = vi.hoisted(() => ({ checkRateLimitMock: vi.fn() }))

vi.mock('../lib/rate-limit', () => ({ checkRateLimit: checkRateLimitMock }))

const weeklyDigestFindFirst = vi.fn()
const weeklyDigestFindMany = vi.fn()
const dailyRollupFindMany = vi.fn()
const dailyRollupGroupBy = vi.fn()
const analyticsEventCreate = vi.fn()
const visitorSessionUpsert = vi.fn()
const visitorSessionUpdateMany = vi.fn()
const visitorSessionFindFirst = vi.fn()
const visitorSessionFindMany = vi.fn()
const visitorSessionCount = vi.fn()
const messageCount = vi.fn()
const questionClusterFindMany = vi.fn()
const placeFindMany = vi.fn()
const placeFindFirst = vi.fn()
const operationalUpdateFindFirst = vi.fn()
const venueFindFirst = vi.fn()
const weeklyReportFindMany = vi.fn()
const weeklyReportFindFirst = vi.fn()
const venueReportConfigurationFindMany = vi.fn()
const venueReportConfigurationFindFirst = vi.fn()
const dbQueryRaw = vi.fn()

const mockDb = {
  weeklyDigest: {
    findFirst: weeklyDigestFindFirst,
    findMany: weeklyDigestFindMany,
  },
  weeklyReport: {
    findMany: weeklyReportFindMany,
    findFirst: weeklyReportFindFirst,
  },
  venueReportConfiguration: {
    findMany: venueReportConfigurationFindMany,
    findFirst: venueReportConfigurationFindFirst,
  },
  venue: {
    findFirst: venueFindFirst,
  },
  dailyRollup: {
    findMany: dailyRollupFindMany,
    groupBy: dailyRollupGroupBy,
  },
  analyticsEvent: {
    create: analyticsEventCreate,
  },
  visitorSession: {
    upsert: visitorSessionUpsert,
    updateMany: visitorSessionUpdateMany,
    findFirst: visitorSessionFindFirst,
    findMany: visitorSessionFindMany,
    count: visitorSessionCount,
  },
  message: {
    count: messageCount,
  },
  questionCluster: {
    findMany: questionClusterFindMany,
  },
  place: {
    findMany: placeFindMany,
    findFirst: placeFindFirst,
  },
  operationalUpdate: {
    findFirst: operationalUpdateFindFirst,
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
    checkRateLimitMock.mockResolvedValue(true)
    visitorSessionUpsert.mockResolvedValue({ id: 'internal_session_1' })
    visitorSessionFindFirst.mockResolvedValue({ id: 'internal_session_1' })
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

  it('analytics.trackEvent records session activity on VisitorSession', async () => {
    dbQueryRaw.mockResolvedValueOnce([{ id: 'cvenueabc123456789012', tenantId: 'tenant_1' }])
    analyticsEventCreate.mockResolvedValueOnce({})
    visitorSessionUpsert.mockResolvedValueOnce({ id: 'internal_session_1' })

    const caller = testRouter.createCaller(anonymousCtx())
    const result = await caller.analytics.trackEvent({
      sessionId: '00000000-0000-4000-8000-000000000001',
      venueId: 'cvenueabc123456789012',
      eventType: 'session.started',
    })

    expect(result).toEqual({ ok: true })
    expect(analyticsEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'cvenueabc123456789012',
          sessionId: 'internal_session_1',
          eventType: 'session.started',
        }),
      }),
    )
    expect(visitorSessionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          venueId_anonymousToken: {
            venueId: 'cvenueabc123456789012',
            anonymousToken: '00000000-0000-4000-8000-000000000001',
          },
          tenantId: 'tenant_1',
        },
        create: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'cvenueabc123456789012',
          anonymousToken: '00000000-0000-4000-8000-000000000001',
        }),
        update: expect.objectContaining({
          lastActiveAt: expect.any(Date),
        }),
      }),
    )
  })

  it('analytics.trackEvent accepts stable synthetic staging entity IDs', async () => {
    dbQueryRaw.mockResolvedValueOnce([
      { id: 'demo-venue-riverside-aquarium', tenantId: 'demo-tenant' },
    ])
    analyticsEventCreate.mockResolvedValueOnce({})

    await expect(
      testRouter.createCaller(anonymousCtx()).analytics.trackEvent({
        sessionId: '00000000-0000-4000-8000-000000000001',
        venueId: 'demo-venue-riverside-aquarium',
        eventType: 'session.started',
      }),
    ).resolves.toEqual({ ok: true })

    expect(visitorSessionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tenantId: 'demo-tenant',
          venueId: 'demo-venue-riverside-aquarium',
        }),
      }),
    )
  })

  it.each([
    'message.sent',
    'message.received',
    'message.fallback',
    'message.low_confidence',
  ] as const)(
    'analytics.trackEvent rejects server-only event %s before database access',
    async (eventType) => {
      const caller = testRouter.createCaller(anonymousCtx())

      await expect(
        caller.analytics.trackEvent({
          sessionId: '00000000-0000-4000-8000-000000000001',
          venueId: 'cvenueabc123456789012',
          // The runtime rejection is the contract under test; this cast keeps the
          // test capable of exercising values excluded by the public TypeScript type.
          eventType: eventType as 'session.started',
        }),
      ).rejects.toThrow()
      expect(dbQueryRaw).not.toHaveBeenCalled()
      expect(analyticsEventCreate).not.toHaveBeenCalled()
    },
  )

  it('analytics.trackEvent applies fixed global ingress before caller-derived keys or venue lookup', async () => {
    checkRateLimitMock.mockReset()
    checkRateLimitMock.mockResolvedValueOnce(false)

    await expect(
      testRouter.createCaller(anonymousCtx()).analytics.trackEvent({
        sessionId: '00000000-0000-4000-8000-000000000001',
        venueId: 'cvenueabc123456789012',
        eventType: 'session.started',
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' })

    expect(checkRateLimitMock).toHaveBeenNthCalledWith(
      1,
      'ratelimit:analytics:ingress:global',
      10_000,
      60,
    )
    expect(checkRateLimitMock).toHaveBeenCalledTimes(1)
    expect(dbQueryRaw).not.toHaveBeenCalled()
    expect(analyticsEventCreate).not.toHaveBeenCalled()
  })

  it('analytics.trackEvent uses one fixed key when venue and session identities rotate', async () => {
    checkRateLimitMock.mockReset()
    checkRateLimitMock.mockResolvedValue(false)
    const inputs = [
      {
        venueId: 'cvenueabc123456789012',
        sessionId: '00000000-0000-4000-8000-000000000001',
      },
      {
        venueId: 'cvenueabc123456789013',
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
      {
        venueId: 'cvenueabc123456789014',
        sessionId: '22222222-2222-4222-8222-222222222222',
      },
    ]

    for (const input of inputs) {
      await expect(
        testRouter.createCaller(anonymousCtx()).analytics.trackEvent({
          ...input,
          eventType: 'session.started',
        }),
      ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' })
    }

    expect(checkRateLimitMock.mock.calls).toEqual(
      inputs.map(() => ['ratelimit:analytics:ingress:global', 10_000, 60]),
    )
    expect(dbQueryRaw).not.toHaveBeenCalled()
    expect(analyticsEventCreate).not.toHaveBeenCalled()
  })

  it('analytics.trackEvent rejects an unknown or inactive venue before derived rate keys or writes', async () => {
    dbQueryRaw.mockResolvedValueOnce([])

    await expect(
      testRouter.createCaller(anonymousCtx()).analytics.trackEvent({
        sessionId: '00000000-0000-4000-8000-000000000001',
        venueId: 'cvenueabc123456789012',
        eventType: 'session.started',
      }),
    ).resolves.toEqual({ ok: false })

    expect(checkRateLimitMock).toHaveBeenCalledTimes(1)
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      'ratelimit:analytics:ingress:global',
      10_000,
      60,
    )
    expect(dbQueryRaw).toHaveBeenCalledTimes(1)
    expect(analyticsEventCreate).not.toHaveBeenCalled()
    expect(visitorSessionUpsert).not.toHaveBeenCalled()
    expect(visitorSessionUpdateMany).not.toHaveBeenCalled()
  })

  it('analytics.trackEvent checks verified venue capacity before creating a session key', async () => {
    checkRateLimitMock.mockReset()
    checkRateLimitMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    dbQueryRaw.mockResolvedValueOnce([{ id: 'cvenueabc123456789012', tenantId: 'tenant_1' }])

    await expect(
      testRouter.createCaller(anonymousCtx()).analytics.trackEvent({
        sessionId: '00000000-0000-4000-8000-000000000001',
        venueId: 'cvenueabc123456789012',
        eventType: 'session.started',
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' })

    expect(checkRateLimitMock).toHaveBeenNthCalledWith(
      1,
      'ratelimit:analytics:ingress:global',
      10_000,
      60,
    )
    expect(checkRateLimitMock).toHaveBeenNthCalledWith(
      2,
      'ratelimit:analytics:venue:cvenueabc123456789012',
      3000,
      60,
    )
    expect(dbQueryRaw).toHaveBeenCalledTimes(1)
    expect(analyticsEventCreate).not.toHaveBeenCalled()
  })

  it('analytics.trackEvent checks the session bucket only after verified venue capacity allows', async () => {
    checkRateLimitMock.mockReset()
    checkRateLimitMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    dbQueryRaw.mockResolvedValueOnce([{ id: 'cvenueabc123456789012', tenantId: 'tenant_1' }])

    await expect(
      testRouter.createCaller(anonymousCtx()).analytics.trackEvent({
        sessionId: '00000000-0000-4000-8000-000000000001',
        venueId: 'cvenueabc123456789012',
        eventType: 'session.started',
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' })

    expect(checkRateLimitMock).toHaveBeenNthCalledWith(
      3,
      'ratelimit:analytics:session:cvenueabc123456789012:00000000-0000-4000-8000-000000000001',
      120,
      60,
    )
    expect(dbQueryRaw).toHaveBeenCalledTimes(1)
    expect(analyticsEventCreate).not.toHaveBeenCalled()
  })

  it('analytics.trackEvent accepts but discards the bounded legacy session timestamp', async () => {
    dbQueryRaw.mockResolvedValueOnce([{ id: 'cvenueabc123456789012', tenantId: 'tenant_1' }])
    analyticsEventCreate.mockResolvedValueOnce({})
    visitorSessionUpsert.mockResolvedValueOnce({ id: 'internal_session_1' })

    await testRouter.createCaller(anonymousCtx()).analytics.trackEvent({
      sessionId: '00000000-0000-4000-8000-000000000001',
      venueId: 'cvenueabc123456789012',
      eventType: 'session.started',
      metadata: { timestamp: '2026-08-09T07:00:00.000Z' },
    })

    const data = analyticsEventCreate.mock.calls[0]?.[0]?.data
    expect(data).toEqual(expect.objectContaining({ occurredAt: expect.any(Date) }))
    expect(data).not.toHaveProperty('metadata')
  })

  it.each([
    {
      sessionId: '00000000-0000-4000-8000-000000000001',
      venueId: 'cvenueabc123456789012',
      eventType: 'session.started',
      occurredAt: '2020-01-01T00:00:00.000Z',
    },
    {
      sessionId: '00000000-0000-4000-8000-000000000001',
      venueId: 'cvenueabc123456789012',
      eventType: 'session.started',
      metadata: { email: 'private@example.com' },
    },
    {
      sessionId: '00000000-0000-4000-8000-000000000001',
      venueId: 'cvenueabc123456789012',
      eventType: 'session.ended',
      metadata: { durationSeconds: 1, extra: 'field' },
    },
    {
      sessionId: '00000000-0000-4000-8000-000000000001',
      venueId: 'cvenueabc123456789012',
      eventType: 'place_card.viewed',
    },
  ])(
    'analytics.trackEvent rejects unbounded or incoherent input before procedure work',
    async (input) => {
      const caller = testRouter.createCaller(anonymousCtx())

      await expect(
        caller.analytics.trackEvent(input as Parameters<typeof caller.analytics.trackEvent>[0]),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(checkRateLimitMock).not.toHaveBeenCalled()
      expect(dbQueryRaw).not.toHaveBeenCalled()
      expect(analyticsEventCreate).not.toHaveBeenCalled()
    },
  )

  it('analytics.trackEvent validates an active place against the resolved venue and tenant', async () => {
    dbQueryRaw.mockResolvedValueOnce([{ id: 'cvenueabc123456789012', tenantId: 'tenant_1' }])
    placeFindFirst.mockResolvedValueOnce({ id: 'cplaceabc123456789012' })
    analyticsEventCreate.mockResolvedValueOnce({})
    visitorSessionUpdateMany.mockResolvedValueOnce({ count: 1 })

    await expect(
      testRouter.createCaller(anonymousCtx()).analytics.trackEvent({
        sessionId: '00000000-0000-4000-8000-000000000001',
        venueId: 'cvenueabc123456789012',
        eventType: 'place_card.viewed',
        placeId: 'cplaceabc123456789012',
      }),
    ).resolves.toEqual({ ok: true })

    expect(placeFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'cplaceabc123456789012',
        tenantId: 'tenant_1',
        venueId: 'cvenueabc123456789012',
        isActive: true,
      },
      select: { id: true },
    })
    expect(analyticsEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'cvenueabc123456789012',
        placeId: 'cplaceabc123456789012',
        occurredAt: expect.any(Date),
      }),
    })
  })

  it('analytics.trackEvent rejects a missing or foreign place without event or session writes', async () => {
    dbQueryRaw.mockResolvedValueOnce([{ id: 'cvenueabc123456789012', tenantId: 'tenant_1' }])
    placeFindFirst.mockResolvedValueOnce(null)

    await expect(
      testRouter.createCaller(anonymousCtx()).analytics.trackEvent({
        sessionId: '00000000-0000-4000-8000-000000000001',
        venueId: 'cvenueabc123456789012',
        eventType: 'place_card.clicked',
        placeId: 'cplaceabc123456789012',
      }),
    ).resolves.toEqual({ ok: false })
    expect(analyticsEventCreate).not.toHaveBeenCalled()
    expect(visitorSessionUpdateMany).not.toHaveBeenCalled()
    expect(visitorSessionUpsert).not.toHaveBeenCalled()
  })

  it('analytics.trackEvent validates a visible operational update and stores only its ID', async () => {
    dbQueryRaw.mockResolvedValueOnce([{ id: 'cvenueabc123456789012', tenantId: 'tenant_1' }])
    operationalUpdateFindFirst.mockResolvedValueOnce({ id: 'cupdateabc12345678901' })
    analyticsEventCreate.mockResolvedValueOnce({})
    visitorSessionUpdateMany.mockResolvedValueOnce({ count: 1 })

    await expect(
      testRouter.createCaller(anonymousCtx()).analytics.trackEvent({
        sessionId: '00000000-0000-4000-8000-000000000001',
        venueId: 'cvenueabc123456789012',
        eventType: 'operational_update.viewed',
        metadata: { operationalUpdateId: 'cupdateabc12345678901' },
      }),
    ).resolves.toEqual({ ok: true })

    const occurredAt = analyticsEventCreate.mock.calls[0]?.[0]?.data?.occurredAt
    expect(operationalUpdateFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'cupdateabc12345678901',
        tenantId: 'tenant_1',
        venueId: 'cvenueabc123456789012',
        status: 'PUBLISHED',
        isActive: true,
        startsAt: { lte: occurredAt },
        expiresAt: { gt: occurredAt },
      },
      select: { id: true },
    })
    expect(analyticsEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: { operationalUpdateId: 'cupdateabc12345678901' },
      }),
    })
  })

  it('analytics.trackEvent rejects a non-visible operational update without writes', async () => {
    dbQueryRaw.mockResolvedValueOnce([{ id: 'cvenueabc123456789012', tenantId: 'tenant_1' }])
    operationalUpdateFindFirst.mockResolvedValueOnce(null)

    await expect(
      testRouter.createCaller(anonymousCtx()).analytics.trackEvent({
        sessionId: '00000000-0000-4000-8000-000000000001',
        venueId: 'cvenueabc123456789012',
        eventType: 'operational_update.viewed',
        metadata: { operationalUpdateId: 'cupdateabc12345678901' },
      }),
    ).resolves.toEqual({ ok: false })
    expect(analyticsEventCreate).not.toHaveBeenCalled()
    expect(visitorSessionUpdateMany).not.toHaveBeenCalled()
    expect(visitorSessionUpsert).not.toHaveBeenCalled()
  })

  it('analytics.trackEvent persists visitorId on the session when provided', async () => {
    dbQueryRaw.mockResolvedValueOnce([{ id: 'cvenueabc123456789012', tenantId: 'tenant_1' }])
    analyticsEventCreate.mockResolvedValueOnce({})
    visitorSessionUpsert.mockResolvedValueOnce({})

    const caller = testRouter.createCaller(anonymousCtx())
    await caller.analytics.trackEvent({
      sessionId: '00000000-0000-4000-8000-000000000001',
      visitorId: '11111111-1111-4111-8111-111111111111',
      venueId: 'cvenueabc123456789012',
      eventType: 'session.started',
    })

    expect(visitorSessionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          visitorId: '11111111-1111-4111-8111-111111111111',
        }),
        update: expect.objectContaining({
          visitorId: '11111111-1111-4111-8111-111111111111',
        }),
      }),
    )
  })

  it('analytics.trackEvent scopes session updates to tenant and venue', async () => {
    dbQueryRaw.mockResolvedValueOnce([{ id: 'cvenueabc123456789012', tenantId: 'tenant_1' }])
    analyticsEventCreate.mockResolvedValueOnce({})
    visitorSessionUpdateMany.mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(anonymousCtx())
    await caller.analytics.trackEvent({
      sessionId: '00000000-0000-4000-8000-000000000001',
      venueId: 'cvenueabc123456789012',
      eventType: 'session.ended',
      metadata: { durationSeconds: 120 },
    })

    expect(visitorSessionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          anonymousToken: '00000000-0000-4000-8000-000000000001',
          tenantId: 'tenant_1',
          venueId: 'cvenueabc123456789012',
        }),
      }),
    )
  })

  it('analytics.getVisitorStats counts unique visitors and total messages', async () => {
    visitorSessionFindMany.mockResolvedValueOnce([
      { visitorId: 'v1', startedAt: new Date('2026-06-10T08:00:00.000Z') },
      { visitorId: 'v1', startedAt: new Date('2026-06-12T09:00:00.000Z') },
      { visitorId: 'v2', startedAt: new Date('2026-06-11T10:00:00.000Z') },
    ])
    visitorSessionCount.mockResolvedValueOnce(5)
    messageCount.mockResolvedValueOnce(42)

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.analytics.getVisitorStats({ days: 30 })

    expect(result).toEqual({ uniqueVisitors: 2, totalMessages: 42, totalSessions: 5 })
    expect(result).not.toHaveProperty('returningVisitors')
    expect(visitorSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ experienceScope: 'PUBLIC' }),
      }),
    )
    expect(visitorSessionCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ experienceScope: 'PUBLIC' }),
      }),
    )
    expect(messageCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ session: { experienceScope: 'PUBLIC' } }),
      }),
    )
  })

  it('analytics.getVisitorStats throws UNAUTHORIZED without a session', async () => {
    const caller = testRouter.createCaller(anonymousCtx())

    await expect(caller.analytics.getVisitorStats({ days: 30 })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'UNAUTHORIZED' }),
    )
  })

  it('analytics.getTopTopics sums topic rollups and labels them', async () => {
    dailyRollupFindMany.mockResolvedValueOnce([
      { category: 'food_drink', value: 3 },
      { category: 'food_drink', value: 2 },
      { category: 'accessibility', value: 4 },
    ])

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.analytics.getTopTopics({ days: 30 })

    expect(result[0]).toEqual({ topic: 'food_drink', label: 'Food & drink', count: 5 })
    expect(result[1]).toEqual({ topic: 'accessibility', label: 'Accessibility', count: 4 })
  })

  it('analytics.getTopTopics throws UNAUTHORIZED without a session', async () => {
    const caller = testRouter.createCaller(anonymousCtx())

    await expect(caller.analytics.getTopTopics({ days: 30 })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'UNAUTHORIZED' }),
    )
  })

  it('analytics.getTopQuestions reads top_question clusters and merges duplicates', async () => {
    questionClusterFindMany.mockResolvedValueOnce([
      { canonicalText: 'Where are the restrooms?', count: 5 },
      { canonicalText: 'where are the restrooms?', count: 2 },
      { canonicalText: 'What time do you close?', count: 4 },
    ])

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.analytics.getTopQuestions({})

    expect(questionClusterFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', kind: 'top_question' },
      }),
    )
    expect(result).toEqual([
      { question: 'Where are the restrooms?', count: 7 },
      { question: 'What time do you close?', count: 4 },
    ])
  })

  it('analytics.getContentGaps reads content_gap clusters with examples', async () => {
    questionClusterFindMany.mockResolvedValueOnce([
      {
        canonicalText: 'Do you have lockers?',
        count: 3,
        examples: ['Do you have lockers?', 'Where can I store my bag?'],
      },
    ])

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.analytics.getContentGaps({ days: 30 })

    expect(questionClusterFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', kind: 'content_gap' },
      }),
    )
    expect(result).toEqual([
      {
        question: 'Do you have lockers?',
        count: 3,
        examples: ['Do you have lockers?', 'Where can I store my bag?'],
      },
    ])
  })

  it('analytics.getContentGaps throws UNAUTHORIZED without a session', async () => {
    const caller = testRouter.createCaller(anonymousCtx())

    await expect(caller.analytics.getContentGaps({ days: 30 })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'UNAUTHORIZED' }),
    )
  })

  it('analytics.getPlaceInterest ranks places by weighted score', async () => {
    dailyRollupFindMany.mockResolvedValueOnce([
      { placeId: 'p1', metric: 'place_mentions', value: 2 },
      { placeId: 'p1', metric: 'place_directions', value: 1 }, // weight 3
      { placeId: 'p2', metric: 'place_card_views', value: 10 }, // weight 1
    ])
    placeFindMany.mockResolvedValueOnce([
      { id: 'p1', name: 'Elephants' },
      { id: 'p2', name: 'Cafe' },
    ])

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.analytics.getPlaceInterest({
      venueId: 'cvenueabc123456789012',
      days: 30,
    })

    // p2: 10*1 = 10; p1: 2*1 + 1*3 = 5
    expect(result.map((place) => place.placeId)).toEqual(['p2', 'p1'])
    expect(result[0]).toMatchObject({ placeId: 'p2', name: 'Cafe', score: 10 })
    expect(result[1]).toMatchObject({ placeId: 'p1', name: 'Elephants', score: 5 })
  })

  it('analytics.getPlaceInterest throws UNAUTHORIZED without a session', async () => {
    const caller = testRouter.createCaller(anonymousCtx())

    await expect(
      caller.analytics.getPlaceInterest({ venueId: 'cvenueabc123456789012', days: 30 }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'UNAUTHORIZED' }))
  })

  it('analytics.getPlaceInterestOverview batches tenant venues into two scoped reads and bounds each group', async () => {
    dailyRollupGroupBy.mockResolvedValueOnce([
      {
        venueId: 'venue_1',
        placeId: 'p1',
        metric: 'place_card_views',
        _sum: { value: 4 },
      },
      {
        venueId: 'venue_1',
        placeId: 'p2',
        metric: 'place_directions',
        _sum: { value: 2 },
      },
      {
        venueId: 'venue_2',
        placeId: 'p3',
        metric: 'place_mentions',
        _sum: { value: 9 },
      },
    ])
    placeFindMany.mockResolvedValueOnce([
      { id: 'p1', name: 'Cafe' },
      { id: 'p2', name: 'Gallery' },
      { id: 'p3', name: 'Garden' },
    ])

    const result = await loadPlaceInterestOverview(mockDb, 'tenant_batched', {
      days: 30,
      limitPerVenue: 1,
    })

    expect(dailyRollupGroupBy).toHaveBeenCalledTimes(1)
    expect(dailyRollupGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['venueId', 'placeId', 'metric'],
        where: expect.objectContaining({ tenantId: 'tenant_batched', placeId: { not: null } }),
        _sum: { value: true },
      }),
    )
    expect(placeFindMany).toHaveBeenCalledTimes(1)
    expect(placeFindMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_batched', id: { in: ['p1', 'p2', 'p3'] } },
      select: { id: true, name: true },
    })
    expect(result).toEqual([
      {
        venueId: 'venue_1',
        places: [expect.objectContaining({ placeId: 'p2', score: 6 })],
      },
      {
        venueId: 'venue_2',
        places: [expect.objectContaining({ placeId: 'p3', score: 9 })],
      },
    ])
  })

  it('analytics.getPlaceInterestOverview does not read place rows when no rollups exist', async () => {
    dailyRollupGroupBy.mockResolvedValueOnce([])
    const result = await loadPlaceInterestOverview(mockDb, 'tenant_1')
    expect(result).toEqual([])
    expect(placeFindMany).not.toHaveBeenCalled()
  })

  it('analytics.listPublishedWeeklyReports only returns PUBLISHED reports for the caller tenant', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })
    venueReportConfigurationFindFirst.mockResolvedValueOnce({ enabled: true })
    weeklyReportFindMany.mockResolvedValueOnce([
      {
        id: 'report_1',
        title: 'PathFinder Weekly Report',
        weekStart: new Date(),
        weekEnd: new Date(),
        content: 'x',
        publishedAt: new Date(),
      },
    ])

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.analytics.listPublishedWeeklyReports({ venueId: 'venue_1' })

    expect(result.items).toHaveLength(1)
    expect(result.nextCursor).toBeNull()
    expect(weeklyReportFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          status: 'PUBLISHED',
        }),
        orderBy: [{ weekStart: 'desc' }, { id: 'desc' }],
        take: 11,
      }),
    )
  })

  it('analytics.listPublishedWeeklyReports returns a stable bounded cursor without report bodies', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })
    venueReportConfigurationFindFirst.mockResolvedValueOnce({ enabled: true })
    const older = new Date('2026-07-01T00:00:00.000Z')
    weeklyReportFindMany.mockResolvedValueOnce([
      {
        id: 'r3',
        title: 'Three',
        weekStart: new Date(),
        weekEnd: new Date(),
        publishedAt: new Date(),
      },
      { id: 'r2', title: 'Two', weekStart: older, weekEnd: new Date(), publishedAt: new Date() },
    ])

    const result = await testRouter
      .createCaller(tenantCtx())
      .analytics.listPublishedWeeklyReports({ venueId: 'venue_1', limit: 1 })

    expect(result.items.map(({ id }) => id)).toEqual(['r3'])
    expect(result.nextCursor).toEqual({ id: 'r3', weekStart: expect.any(Date) })
    expect(weeklyReportFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        select: expect.not.objectContaining({ content: true }),
      }),
    )
  })

  it('analytics.getPublishedWeeklyReport is exactly tenant, venue, status, and id scoped', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })
    venueReportConfigurationFindFirst.mockResolvedValueOnce({ enabled: true })
    weeklyReportFindFirst.mockResolvedValueOnce({
      id: 'report_1',
      title: 'Report',
      weekStart: new Date(),
      weekEnd: new Date(),
      content: 'Safe published copy',
      publishedAt: new Date(),
    })

    await testRouter.createCaller(tenantCtx()).analytics.getPublishedWeeklyReport({
      venueId: 'venue_1',
      reportId: 'report_1',
    })

    expect(weeklyReportFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'report_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          status: 'PUBLISHED',
        },
      }),
    )
  })

  it('analytics.listPublishedWeeklyReports throws NOT_FOUND when the venue does not belong to the caller tenant', async () => {
    venueFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(tenantCtx())

    await expect(
      caller.analytics.listPublishedWeeklyReports({ venueId: 'someone_elses_venue' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'someone_elses_venue', tenantId: 'tenant_1', isActive: true },
      select: { id: true },
    })
    expect(weeklyReportFindMany).not.toHaveBeenCalled()
  })

  it('analytics.listPublishedWeeklyReports fails closed when the venue is not enabled', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })
    venueReportConfigurationFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(tenantCtx())

    await expect(
      caller.analytics.listPublishedWeeklyReports({ venueId: 'venue_1' }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'PRECONDITION_FAILED' }),
    )
    expect(weeklyReportFindMany).not.toHaveBeenCalled()
  })

  it('analytics.getWeeklyReportAvailability returns only explicitly enabled active venues', async () => {
    venueReportConfigurationFindMany.mockResolvedValueOnce([
      { venueId: 'venue_1' },
      { venueId: 'venue_3' },
    ])

    const caller = testRouter.createCaller(tenantCtx())

    await expect(caller.analytics.getWeeklyReportAvailability()).resolves.toEqual({
      enabledVenueIds: ['venue_1', 'venue_3'],
    })
    expect(venueReportConfigurationFindMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', enabled: true, venue: { isActive: true } },
      orderBy: { venueId: 'asc' },
      select: { venueId: true },
    })
  })
})
