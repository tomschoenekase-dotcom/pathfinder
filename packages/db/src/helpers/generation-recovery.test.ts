import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  bypass: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}))

vi.mock('../client', () => ({ db: { $queryRaw: mocks.queryRaw } }))
vi.mock('../middleware/tenant-isolation', () => ({
  withTenantIsolationBypass: mocks.bypass,
}))

import {
  discoverExpiredGenerationExecutions,
  GENERATION_RECOVERY_MAX_PER_TYPE,
} from './generation-recovery'

describe('generation recovery discovery', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns both discovery states through one explicit tenant bypass', async () => {
    const rangeStart = new Date('2026-08-01T00:00:00.000Z')
    const rangeEnd = new Date('2026-08-08T00:00:00.000Z')
    const answer = {
      snapshotId: 'snapshot_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      rangeStart,
      rangeEnd,
      executionLeaseToken: '00000000-0000-4000-8000-000000000001',
    }
    const report = {
      reportId: 'report_1',
      tenantId: 'tenant_2',
      venueId: 'venue_2',
      weekStart: rangeStart,
      weekEnd: rangeEnd,
      executionLeaseToken: '00000000-0000-4000-8000-000000000002',
    }
    mocks.queryRaw.mockResolvedValueOnce([answer]).mockResolvedValueOnce([report])

    await expect(discoverExpiredGenerationExecutions({ limitPerType: 7 })).resolves.toEqual({
      answerAnalyses: [answer],
      weeklyReports: [report],
    })
    expect(mocks.bypass).toHaveBeenCalledOnce()
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2)
    expect(mocks.queryRaw.mock.calls.map((call) => call.slice(1))).toEqual([[7], [7]])
  })

  it('uses the hard maximum as the default bound', async () => {
    mocks.queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await expect(discoverExpiredGenerationExecutions()).resolves.toEqual({
      answerAnalyses: [],
      weeklyReports: [],
    })
    expect(mocks.queryRaw.mock.calls.map((call) => call.slice(1))).toEqual([
      [GENERATION_RECOVERY_MAX_PER_TYPE],
      [GENERATION_RECOVERY_MAX_PER_TYPE],
    ])
  })

  it.each([-1, 0, 51, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number])(
    'rejects invalid bound %s before bypass or SQL',
    async (limitPerType) => {
      await expect(discoverExpiredGenerationExecutions({ limitPerType })).rejects.toThrow(
        'Generation recovery limit must be an integer between 1 and 50.',
      )
      expect(mocks.bypass).not.toHaveBeenCalled()
      expect(mocks.queryRaw).not.toHaveBeenCalled()
    },
  )
})
