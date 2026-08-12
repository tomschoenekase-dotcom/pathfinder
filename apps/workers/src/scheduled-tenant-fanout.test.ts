import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  enqueueAnalyticsEnrichment: vi.fn(),
  enqueueDailyRollup: vi.fn(),
  enqueueWeeklyDigest: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  tenantFindMany: vi.fn(),
  prepareWeeklyDigestIntentAction: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    tenant: { findMany: mocks.tenantFindMany },
  },
  prepareWeeklyDigestIntentAction: mocks.prepareWeeklyDigestIntentAction,
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
}))

vi.mock('@pathfinder/jobs', () => ({
  enqueueAnalyticsEnrichment: mocks.enqueueAnalyticsEnrichment,
  enqueueDailyRollup: mocks.enqueueDailyRollup,
  enqueueWeeklyDigest: mocks.enqueueWeeklyDigest,
}))

import {
  enqueueScheduledAnalyticsEnrichment,
  enqueueScheduledDailyRollups,
  enqueueScheduledWeeklyDigests,
  runScheduledTenantFanout,
  ScheduledTenantFanoutError,
} from './scheduled-tenant-fanout'

describe('scheduled tenant fan-out', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.withTenantIsolationBypass.mockImplementation((run: () => unknown) => run())
    mocks.enqueueAnalyticsEnrichment.mockResolvedValue(undefined)
    mocks.enqueueDailyRollup.mockResolvedValue(undefined)
    mocks.enqueueWeeklyDigest.mockResolvedValue(undefined)
  })

  it('returns truthful empty-state counts without starting work', async () => {
    const run = vi.fn()
    await expect(
      runScheduledTenantFanout({ schedulerKind: 'empty', tenantIds: [], run }),
    ).resolves.toEqual({ tenantCount: 0, acceptedCount: 0, skippedCount: 0, failedCount: 0 })
    expect(run).not.toHaveBeenCalled()
  })

  it('bounds concurrency while attempting every tenant', async () => {
    let active = 0
    let maximumActive = 0
    const tenantIds = Array.from({ length: 500 }, (_, index) => `tenant_${index}`)

    const result = await runScheduledTenantFanout({
      schedulerKind: 'bounded',
      tenantIds,
      concurrency: 8,
      run: async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        active -= 1
        return 'accepted'
      },
    })

    expect(result).toEqual({
      tenantCount: 500,
      acceptedCount: 500,
      skippedCount: 0,
      failedCount: 0,
    })
    expect(maximumActive).toBe(8)
  })

  it('continues after a tenant failure, logs no exception text, then throws aggregate failure', async () => {
    const visited: string[] = []
    const execution = runScheduledTenantFanout({
      schedulerKind: 'partial',
      tenantIds: ['tenant_a', 'tenant_b', 'tenant_c'],
      concurrency: 2,
      run: async (tenantId) => {
        visited.push(tenantId)
        if (tenantId === 'tenant_b') throw new Error('private@example.com provider detail')
        return 'accepted'
      },
    })

    await expect(execution).rejects.toMatchObject({
      name: 'ScheduledTenantFanoutError',
      result: { tenantCount: 3, acceptedCount: 2, skippedCount: 0, failedCount: 1 },
    })
    expect(visited.sort()).toEqual(['tenant_a', 'tenant_b', 'tenant_c'])
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain('private@example.com')
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('private@example.com')
  })

  it.each([0, 1.5, 101])('rejects invalid concurrency %s before work', async (concurrency) => {
    await expect(
      runScheduledTenantFanout({
        schedulerKind: 'invalid',
        tenantIds: ['tenant_a'],
        concurrency,
        run: vi.fn().mockResolvedValue('accepted'),
      }),
    ).rejects.toThrow('concurrency must be an integer from 1 to 100')
  })

  it('enqueues daily rollups for exactly the active tenants and previous UTC day', async () => {
    mocks.tenantFindMany.mockResolvedValue([{ id: 'tenant_a' }, { id: 'tenant_b' }])
    await enqueueScheduledDailyRollups(new Date('2026-08-08T23:45:00.000Z'))

    expect(mocks.tenantFindMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE' },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true },
    })
    expect(mocks.enqueueDailyRollup.mock.calls).toEqual([
      [{ tenantId: 'tenant_a', date: '2026-08-07T00:00:00.000Z' }],
      [{ tenantId: 'tenant_b', date: '2026-08-07T00:00:00.000Z' }],
    ])
    expect(mocks.loggerInfo).toHaveBeenCalledWith({
      action: 'workers.daily-rollup.scheduler.completed',
      date: '2026-08-07T00:00:00.000Z',
      tenantCount: 2,
      acceptedCount: 2,
      skippedCount: 0,
      failedCount: 0,
    })
  })

  it('attempts later analytics tenants before surfacing a retryable aggregate failure', async () => {
    mocks.tenantFindMany.mockResolvedValue([
      { id: 'tenant_a' },
      { id: 'tenant_b' },
      { id: 'tenant_c' },
    ])
    mocks.enqueueAnalyticsEnrichment.mockImplementation(async ({ tenantId }) => {
      if (tenantId === 'tenant_b') throw new Error('queue unavailable')
    })

    await expect(
      enqueueScheduledAnalyticsEnrichment(new Date('2026-08-08T01:30:00.000Z')),
    ).rejects.toBeInstanceOf(ScheduledTenantFanoutError)
    expect(mocks.enqueueAnalyticsEnrichment.mock.calls).toEqual([
      [{ tenantId: 'tenant_a', date: '2026-08-07T00:00:00.000Z' }],
      [{ tenantId: 'tenant_b', date: '2026-08-07T00:00:00.000Z' }],
      [{ tenantId: 'tenant_c', date: '2026-08-07T00:00:00.000Z' }],
    ])
  })

  it('keyset-paginates active tenants and retains only one bounded page at a time', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `tenant_${String(index).padStart(3, '0')}`,
    }))
    mocks.tenantFindMany
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([{ id: 'tenant_100' }])

    await enqueueScheduledDailyRollups(new Date('2026-08-08T01:00:00.000Z'))

    expect(mocks.tenantFindMany).toHaveBeenNthCalledWith(2, {
      where: { status: 'ACTIVE', id: { gt: 'tenant_099' } },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true },
    })
    expect(mocks.enqueueDailyRollup).toHaveBeenCalledTimes(101)
    expect(mocks.enqueueDailyRollup).toHaveBeenLastCalledWith({
      tenantId: 'tenant_100',
      date: '2026-08-07T00:00:00.000Z',
    })
  })

  it('atomically reconciles weekly states and enqueues only pending work', async () => {
    mocks.tenantFindMany.mockResolvedValue([
      { id: 'tenant_complete' },
      { id: 'tenant_processing' },
      { id: 'tenant_pending' },
      { id: 'tenant_failed' },
    ])
    mocks.prepareWeeklyDigestIntentAction.mockImplementation(async ({ tenantId }) => {
      const status = tenantId.replace('tenant_', '').toUpperCase()
      return {
        id: `digest_${tenantId}`,
        status: status === 'FAILED' ? 'PENDING' : status,
        enqueueAllowed: status === 'PENDING' || status === 'FAILED',
        outcome: status === 'FAILED' ? 'RESET' : 'REPLAYED',
      }
    })

    await enqueueScheduledWeeklyDigests(new Date('2026-08-08T12:00:00.000Z'))

    expect(mocks.prepareWeeklyDigestIntentAction).toHaveBeenCalledTimes(4)
    expect(mocks.prepareWeeklyDigestIntentAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_failed',
        actor: { type: 'SYSTEM', id: 'weekly-digest-scheduler', role: 'SYSTEM' },
      }),
      expect.anything(),
    )
    expect(mocks.enqueueWeeklyDigest.mock.calls).toEqual([
      [
        {
          tenantId: 'tenant_pending',
          weekStart: '2026-08-03T00:00:00.000Z',
          weekEnd: '2026-08-09T23:59:59.999Z',
          digestId: 'digest_tenant_pending',
        },
      ],
      [
        {
          tenantId: 'tenant_failed',
          weekStart: '2026-08-03T00:00:00.000Z',
          weekEnd: '2026-08-09T23:59:59.999Z',
          digestId: 'digest_tenant_failed',
        },
      ],
    ])
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ acceptedCount: 2, skippedCount: 2, failedCount: 0 }),
    )
  })

  it('does not reset or enqueue a digest that wins a concurrent FAILED transition', async () => {
    mocks.tenantFindMany.mockResolvedValue([{ id: 'tenant_a' }])
    mocks.prepareWeeklyDigestIntentAction.mockResolvedValue({
      id: 'digest_a',
      status: 'PROCESSING',
      enqueueAllowed: false,
      outcome: 'RACED',
    })

    await enqueueScheduledWeeklyDigests(new Date('2026-08-08T12:00:00.000Z'))

    expect(mocks.enqueueWeeklyDigest).not.toHaveBeenCalled()
  })
})
