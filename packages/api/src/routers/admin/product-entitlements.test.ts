import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  venueFindFirst: vi.fn(),
  voiceFindMany: vi.fn(),
  usageAggregate: vi.fn(),
  resolveEntitlement: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    venue: { findFirst: mocks.venueFindFirst },
    voiceSession: { findMany: mocks.voiceFindMany },
    aiUsageEvent: { aggregate: mocks.usageAggregate },
  },
  resolveProductEntitlement: mocks.resolveEntitlement,
  withTenantIsolationBypass: mocks.bypass,
  writeAuditLogStrict: vi.fn(),
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminProductEntitlementsRouter } from './product-entitlements'

const testRouter = router({ admin: adminProductEntitlementsRouter })
const summaryInput = { tenantId: 'tenant-1', venueId: 'venue-1', month: '2026-08' }

function decimalMock(fixed: string, perMinute = fixed) {
  return {
    toFixed: () => fixed,
    dividedBy: () => ({ times: () => ({ toFixed: () => perMinute }) }),
  }
}

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator-1',
      activeTenantId: 'unrelated-tenant',
      role: 'STAFF',
      isPlatformAdmin,
    },
  }
}

describe('admin venue voice usage summary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.venueFindFirst.mockResolvedValue({ id: 'venue-1' })
    mocks.voiceFindMany.mockResolvedValue([
      {
        connectedAt: new Date('2026-08-10T12:00:00.000Z'),
        endedAt: new Date('2026-08-10T12:15:00.000Z'),
        durationSeconds: 900,
        maxDurationSeconds: 900,
      },
    ])
    mocks.usageAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: decimalMock('0.18750000', '0.01250000') },
    })
  })

  it('returns only a scoped monthly aggregate and computes estimated cost per minute', async () => {
    const result = await testRouter
      .createCaller(context())
      .admin.getVenueVoiceUsageSummary(summaryInput)

    expect(result).toEqual({
      month: '2026-08',
      durationSeconds: 900,
      minutes: 15,
      sessionCount: 1,
      estimatedCostUsd: '0.18750000',
      estimatedCostPerMinuteUsd: '0.01250000',
      costIsEstimate: true,
      durationAttribution: 'voiceSession.connectedAt UTC-month overlap',
      costAttribution: 'AiUsageEvent.createdAt',
    })
    expect(mocks.voiceFindMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        connectedAt: { not: null, lt: new Date('2026-09-01T00:00:00.000Z') },
        OR: [{ endedAt: null }, { endedAt: { gt: new Date('2026-08-01T00:00:00.000Z') } }],
      },
      select: {
        connectedAt: true,
        endedAt: true,
        durationSeconds: true,
        maxDurationSeconds: true,
      },
    })
    expect(mocks.usageAggregate).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        feature: 'realtime-voice',
        usageObservationStatus: 'CLIENT_REPORTED',
        createdAt: {
          gte: new Date('2026-08-01T00:00:00.000Z'),
          lt: new Date('2026-09-01T00:00:00.000Z'),
        },
      },
      _sum: { estimatedCostUsd: true },
    })
  })

  it('does not query usage for an unknown venue or a non-admin', async () => {
    mocks.venueFindFirst.mockResolvedValue(null)
    await expect(
      testRouter.createCaller(context()).admin.getVenueVoiceUsageSummary(summaryInput),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.voiceFindMany).not.toHaveBeenCalled()

    await expect(
      testRouter.createCaller(context(false)).admin.getVenueVoiceUsageSummary(summaryInput),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).toHaveBeenCalledTimes(1)
  })

  it('validates the month and represents cost per minute as unavailable when usage is zero', async () => {
    await expect(
      testRouter
        .createCaller(context())
        .admin.getVenueVoiceUsageSummary({ ...summaryInput, month: '2026-13' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    mocks.voiceFindMany.mockResolvedValue([])
    mocks.usageAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: decimalMock('0.00000000') },
    })
    const result = await testRouter
      .createCaller(context())
      .admin.getVenueVoiceUsageSummary(summaryInput)
    expect(result.estimatedCostPerMinuteUsd).toBeNull()
  })

  it('preserves eight-decimal cost estimates and handles years below 0100', async () => {
    mocks.voiceFindMany.mockResolvedValue([
      {
        connectedAt: new Date('0001-08-10T12:00:00.000Z'),
        endedAt: new Date('0001-08-10T12:01:00.000Z'),
        durationSeconds: 60,
        maxDurationSeconds: 600,
      },
    ])
    mocks.usageAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: decimalMock('0.00000025', '0.00000025') },
    })

    const result = await testRouter
      .createCaller(context())
      .admin.getVenueVoiceUsageSummary({ ...summaryInput, month: '0001-08' })

    expect(result.estimatedCostUsd).toBe('0.00000025')
    expect(result.estimatedCostPerMinuteUsd).toBe('0.00000025')
    expect(mocks.voiceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          connectedAt: { not: null, lt: new Date('0001-09-01T00:00:00.000Z') },
          OR: [{ endedAt: null }, { endedAt: { gt: new Date('0001-08-01T00:00:00.000Z') } }],
        }),
      }),
    )
  })

  it('allocates a cross-month session duration to the same UTC month as its usage events', async () => {
    mocks.voiceFindMany.mockResolvedValue([
      {
        connectedAt: new Date('2026-07-31T23:59:30.000Z'),
        endedAt: new Date('2026-08-01T00:00:30.000Z'),
        durationSeconds: 60,
        maxDurationSeconds: 600,
      },
    ])
    mocks.usageAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: decimalMock('0.00000025', '0.00000050') },
    })

    const result = await testRouter
      .createCaller(context())
      .admin.getVenueVoiceUsageSummary(summaryInput)

    expect(result).toMatchObject({
      month: '2026-08',
      durationSeconds: 30,
      minutes: 0.5,
      sessionCount: 1,
      estimatedCostUsd: '0.00000025',
      estimatedCostPerMinuteUsd: '0.00000050',
    })
    expect(mocks.usageAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-08-01T00:00:00.000Z'),
            lt: new Date('2026-09-01T00:00:00.000Z'),
          },
        }),
      }),
    )
  })
})
