import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ rows: vi.fn(), tenant: vi.fn() }))
vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: async (operation: () => Promise<unknown>) => operation(),
  db: { tenant: { findUnique: mocks.tenant }, aiUsageDailyRollup: { findMany: mocks.rows } },
}))
import { adminClientAnalyticsRouter } from './client-analytics'
import type { TRPCContext } from '../../context'

const context = {
  db: {},
  headers: new Headers(),
  session: {
    userId: 'operator-1',
    activeTenantId: 'other-tenant',
    role: 'STAFF',
    isPlatformAdmin: true,
  },
} as TRPCContext

describe('client AI cost coverage', () => {
  it.each([false, true])(
    'preserves observed and unknown coverage through every aggregation (mixed=%s)',
    async (mixed) => {
      mocks.tenant.mockResolvedValue({ id: 'tenant-1', name: 'Fixture', slug: 'fixture' })
      mocks.rows.mockResolvedValue([
        {
          date: new Date('2026-09-07'),
          venueId: 'venue-1',
          venue: { name: 'Museum' },
          feature: 'chat',
          requestCount: mixed ? 4 : 1,
          successfulRequestCount: 1,
          failedRequestCount: mixed ? 3 : 0,
          observedUsageRequestCount: 1,
          unknownUsageRequestCount: mixed ? 1 : 0,
          notDispatchedRequestCount: mixed ? 1 : 0,
          legacyUnclassifiedRequestCount: mixed ? 1 : 0,
          totalTokens: 15,
          estimatedCostUsd: '3.00000000',
          observedTotalTokens: 10,
          observedEstimatedCostUsd: { toString: () => '2.00000000' },
        },
      ])
      const result = await adminClientAnalyticsRouter
        .createCaller(context)
        .getClientAiCosts({ tenantId: 'tenant-1' })
      const status = mixed ? 'PARTIAL_RECORDED_USAGE' : 'COMPLETE_RECORDED_USAGE'
      expect(result.totals).toMatchObject({
        estimatedCostUsd: '3.00000000',
        observedEstimatedCostUsd: '2.00000000',
        usageCoverage: { status },
      })
      expect(result.breakdown[0]).toMatchObject({
        usageCoverageStatus: status,
        observedEstimatedCostUsd: '2.00000000',
        unknownRequestCount: mixed ? 1 : 0,
      })
      expect(result.breakdown[0]?.features[0]).toMatchObject({
        usageCoverageStatus: status,
        observedEstimatedCostUsd: '2.00000000',
      })
      expect(result.costs[0]?.usageCoverageStatus).toBe(status)
      expect(result.costs[0]?.observedEstimatedCostUsd).toBe('2.00000000')
      expect(mocks.rows).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-1' }) }),
      )
    },
  )

  it('distinguishes an empty window from a zero-cost observed window', async () => {
    mocks.tenant.mockResolvedValue({ id: 'tenant-1', name: 'Fixture', slug: 'fixture' })
    mocks.rows.mockResolvedValue([])
    const result = await adminClientAnalyticsRouter
      .createCaller(context)
      .getClientAiCosts({ tenantId: 'tenant-1' })
    expect(result.totals.usageCoverage.status).toBe('NO_RECORDED_USAGE')
    expect(result.breakdown).toEqual([])
  })
})
