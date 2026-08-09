import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  answerFindFirst: vi.fn(),
  reportFindFirst: vi.fn(),
  transaction: vi.fn(),
  bypass: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}))

vi.mock('../client', () => ({
  db: {
    $transaction: mocks.transaction,
    $executeRaw: mocks.executeRaw,
    answerAnalysisSnapshot: { findFirst: mocks.answerFindFirst },
    weeklyReport: { findFirst: mocks.reportFindFirst },
  },
}))
vi.mock('../middleware/tenant-isolation', () => ({
  withTenantIsolationBypass: mocks.bypass,
}))

import {
  acquireAnswerAnalysisExecution,
  acquireAnswerAnalysisRecoveryExecution,
  acquireWeeklyReportExecution,
  acquireWeeklyReportRecoveryExecution,
  deferAnswerAnalysisExecution,
  deferWeeklyReportExecution,
  GENERATION_EXECUTION_LEASE_MS,
} from './generation-execution-claims'

const rangeStart = new Date('2026-08-01T00:00:00.000Z')
const rangeEnd = new Date('2026-08-08T00:00:00.000Z')
const analysisIdentity = {
  snapshotId: 'snapshot_1',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  rangeStart,
  rangeEnd,
}
const reportIdentity = {
  reportId: 'report_1',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  weekStart: rangeStart,
  weekEnd: rangeEnd,
}
const observedLeaseToken = '00000000-0000-4000-8000-000000000001'

function expectExactRecoveryPredicate(call: unknown[]): void {
  const sql = (call[0] as readonly string[]).join('?')
  expect(sql).toContain("status = 'GENERATING'")
  expect(sql).not.toContain('status IN')
  expect(sql).toContain('execution_lease_token = ?::uuid')
  expect(sql).toContain('execution_lease_expires_at IS NOT NULL')
  expect(sql).toContain('execution_lease_expires_at <= clock_timestamp()')
  expect(sql).toContain("status = 'FAILED'")
  expect(sql).toContain('AND execution_lease_token IS NULL')
  expect(sql).toContain('execution_lease_expires_at IS NULL')
  expect(sql.match(/recovery_lineage_token = \?::uuid/g)).toHaveLength(3)
  expect(sql).toContain('execution_lease_token IS NULL')
  expect(sql).toContain('execution_lease_expires_at IS NULL')
  expect(sql).toMatch(/SET[\s\S]*recovery_lineage_token = \?::uuid[\s\S]*WHERE/)
}

describe('generation execution claims', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.executeRaw.mockResolvedValue(1)
    mocks.transaction.mockImplementation(async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        $executeRaw: mocks.executeRaw,
        answerAnalysisSnapshot: { findFirst: mocks.answerFindFirst },
        weeklyReport: { findFirst: mocks.reportFindFirst },
      }),
    )
  })

  it('uses a fresh internal UUID and the DB-clock lease duration for answer analysis', async () => {
    mocks.executeRaw.mockResolvedValueOnce(1)

    const result = await acquireAnswerAnalysisExecution(analysisIdentity)

    expect(result).toMatchObject({ state: 'acquired' })
    if (result.state !== 'acquired') throw new Error('Expected acquisition')
    expect(result.leaseToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    const values = mocks.executeRaw.mock.calls[0]!.slice(1)
    expect(values).toEqual([
      result.leaseToken,
      GENERATION_EXECUTION_LEASE_MS,
      'snapshot_1',
      'tenant_1',
      'venue_1',
      rangeStart,
      rangeEnd,
    ])
    expect((mocks.executeRaw.mock.calls[0]![0] as readonly string[]).join('?')).toContain(
      'recovery_lineage_token = NULL',
    )
    expect(mocks.answerFindFirst).not.toHaveBeenCalled()
  })

  it('uses a fresh internal UUID and the DB-clock lease duration for weekly reports', async () => {
    mocks.executeRaw.mockResolvedValueOnce(1)

    const result = await acquireWeeklyReportExecution(reportIdentity)

    expect(result).toMatchObject({ state: 'acquired' })
    if (result.state !== 'acquired') throw new Error('Expected acquisition')
    const values = mocks.executeRaw.mock.calls[0]!.slice(1)
    expect(values).toEqual([
      result.leaseToken,
      GENERATION_EXECUTION_LEASE_MS,
      'report_1',
      'tenant_1',
      'venue_1',
      rangeStart,
      rangeEnd,
    ])
    expect((mocks.executeRaw.mock.calls[0]![0] as readonly string[]).join('?')).toContain(
      'recovery_lineage_token = NULL',
    )
    expect(mocks.reportFindFirst).not.toHaveBeenCalled()
  })

  it('releases only the exact answer-analysis lease while retaining retryable state', async () => {
    mocks.executeRaw.mockResolvedValueOnce(1)

    await expect(
      deferAnswerAnalysisExecution({
        ...analysisIdentity,
        leaseToken: observedLeaseToken,
      }),
    ).resolves.toBe(true)

    const call = mocks.executeRaw.mock.calls[0]!
    expect((call[0] as readonly string[]).join('?')).toContain("status = 'GENERATING'")
    expect((call[0] as readonly string[]).join('?')).toContain('execution_lease_token = ?::uuid')
    expect(call.slice(1)).toEqual([
      'snapshot_1',
      'tenant_1',
      'venue_1',
      rangeStart,
      rangeEnd,
      observedLeaseToken,
    ])
  })

  it('reports a lost weekly-report deferral fence without broadening the update', async () => {
    mocks.executeRaw.mockResolvedValueOnce(0)

    await expect(
      deferWeeklyReportExecution({
        ...reportIdentity,
        leaseToken: observedLeaseToken,
      }),
    ).resolves.toBe(false)

    const call = mocks.executeRaw.mock.calls[0]!
    expect((call[0] as readonly string[]).join('?')).toContain("status = 'GENERATING'")
    expect(call.slice(1)).toEqual([
      'report_1',
      'tenant_1',
      'venue_1',
      rangeStart,
      rangeEnd,
      observedLeaseToken,
    ])
  })

  it.each(['GENERATING', 'FAILED'] as const)(
    'reports an answer-analysis %s row as leased after losing acquisition',
    async (status) => {
      mocks.executeRaw.mockResolvedValueOnce(0)
      mocks.answerFindFirst.mockResolvedValueOnce({ status })

      await expect(acquireAnswerAnalysisExecution(analysisIdentity)).resolves.toEqual({
        state: 'leased',
      })
      expect(mocks.answerFindFirst).toHaveBeenCalledWith({
        where: {
          id: 'snapshot_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          rangeStart,
          rangeEnd,
        },
        select: { status: true },
      })
    },
  )

  it.each(['GENERATING', 'FAILED'] as const)(
    'reports a weekly-report %s row as leased after losing acquisition',
    async (status) => {
      mocks.executeRaw.mockResolvedValueOnce(0)
      mocks.reportFindFirst.mockResolvedValueOnce({ status })

      await expect(acquireWeeklyReportExecution(reportIdentity)).resolves.toEqual({
        state: 'leased',
      })
      expect(mocks.reportFindFirst).toHaveBeenCalledWith({
        where: {
          id: 'report_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          weekStart: rangeStart,
          weekEnd: rangeEnd,
        },
        select: { status: true },
      })
    },
  )

  it.each(['COMPLETE'] as const)('reports answer-analysis %s as terminal', async (status) => {
    mocks.executeRaw.mockResolvedValueOnce(0)
    mocks.answerFindFirst.mockResolvedValueOnce({ status })
    await expect(acquireAnswerAnalysisExecution(analysisIdentity)).resolves.toEqual({
      state: 'terminal',
    })
  })

  it.each(['DRAFT', 'PUBLISHED'] as const)(
    'reports weekly-report %s as terminal',
    async (status) => {
      mocks.executeRaw.mockResolvedValueOnce(0)
      mocks.reportFindFirst.mockResolvedValueOnce({ status })
      await expect(acquireWeeklyReportExecution(reportIdentity)).resolves.toEqual({
        state: 'terminal',
      })
    },
  )

  it('returns missing for an answer-analysis scope or range mismatch', async () => {
    mocks.executeRaw.mockResolvedValueOnce(0)
    mocks.answerFindFirst.mockResolvedValueOnce(null)
    await expect(acquireAnswerAnalysisExecution(analysisIdentity)).resolves.toEqual({
      state: 'missing',
    })
  })

  it('returns missing for a weekly-report scope or range mismatch', async () => {
    mocks.executeRaw.mockResolvedValueOnce(0)
    mocks.reportFindFirst.mockResolvedValueOnce(null)
    await expect(acquireWeeklyReportExecution(reportIdentity)).resolves.toEqual({
      state: 'missing',
    })
  })

  it('atomically replaces the exact expired answer-analysis recovery token', async () => {
    mocks.executeRaw.mockResolvedValueOnce(1)

    const result = await acquireAnswerAnalysisRecoveryExecution({
      ...analysisIdentity,
      observedLeaseToken,
    })

    expect(result).toMatchObject({ state: 'acquired' })
    if (result.state !== 'acquired') throw new Error('Expected recovery acquisition')
    expect(result.leaseToken).not.toBe(observedLeaseToken)
    expect(mocks.executeRaw.mock.calls[0]!.slice(1)).toEqual([
      result.leaseToken,
      GENERATION_EXECUTION_LEASE_MS,
      observedLeaseToken,
      'snapshot_1',
      'tenant_1',
      'venue_1',
      rangeStart,
      rangeEnd,
      observedLeaseToken,
      observedLeaseToken,
      observedLeaseToken,
    ])
    expectExactRecoveryPredicate(mocks.executeRaw.mock.calls[0]!)
    expect(mocks.answerFindFirst).not.toHaveBeenCalled()
  })

  it('atomically replaces the exact expired weekly-report recovery token', async () => {
    mocks.executeRaw.mockResolvedValueOnce(1)

    const result = await acquireWeeklyReportRecoveryExecution({
      ...reportIdentity,
      observedLeaseToken,
    })

    expect(result).toMatchObject({ state: 'acquired' })
    if (result.state !== 'acquired') throw new Error('Expected recovery acquisition')
    expect(result.leaseToken).not.toBe(observedLeaseToken)
    expect(mocks.executeRaw.mock.calls[0]!.slice(1)).toEqual([
      result.leaseToken,
      GENERATION_EXECUTION_LEASE_MS,
      observedLeaseToken,
      'report_1',
      'tenant_1',
      'venue_1',
      rangeStart,
      rangeEnd,
      observedLeaseToken,
      observedLeaseToken,
      observedLeaseToken,
    ])
    expectExactRecoveryPredicate(mocks.executeRaw.mock.calls[0]!)
    expect(mocks.reportFindFirst).not.toHaveBeenCalled()
  })

  it('permits a fenced recovery retry after the prior attempt failed and cleared its lease', async () => {
    mocks.executeRaw.mockResolvedValueOnce(1)
    const result = await acquireAnswerAnalysisRecoveryExecution({
      ...analysisIdentity,
      observedLeaseToken,
    })
    expect(result.state).toBe('acquired')
    const sql = (mocks.executeRaw.mock.calls[0]?.[0] as readonly string[]).join('?')
    expect(sql).toContain("OR (status = 'FAILED'")
    expect(sql).toContain('AND execution_lease_token IS NULL')
    expect(sql).toContain("status = 'GENERATING'")
    expect(sql).toContain('error = NULL')
    expect(sql).toContain('recovery_lineage_token = ?::uuid')
  })

  it.each([
    ['GENERATING', 'ineligible'],
    ['FAILED', 'ineligible'],
    ['COMPLETE', 'terminal'],
  ] as const)('classifies answer-analysis recovery status %s as %s', async (status, state) => {
    mocks.executeRaw.mockResolvedValueOnce(0)
    mocks.answerFindFirst.mockResolvedValueOnce({ status })
    await expect(
      acquireAnswerAnalysisRecoveryExecution({ ...analysisIdentity, observedLeaseToken }),
    ).resolves.toEqual({ state })
  })

  it.each([
    ['GENERATING', 'ineligible'],
    ['FAILED', 'ineligible'],
    ['DRAFT', 'terminal'],
    ['PUBLISHED', 'terminal'],
  ] as const)('classifies weekly-report recovery status %s as %s', async (status, state) => {
    mocks.executeRaw.mockResolvedValueOnce(0)
    mocks.reportFindFirst.mockResolvedValueOnce({ status })
    await expect(
      acquireWeeklyReportRecoveryExecution({ ...reportIdentity, observedLeaseToken }),
    ).resolves.toEqual({ state })
  })

  it('returns missing for recovery scope or range mismatch', async () => {
    mocks.executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(0)
    mocks.answerFindFirst.mockResolvedValueOnce(null)
    mocks.reportFindFirst.mockResolvedValueOnce(null)

    await expect(
      acquireAnswerAnalysisRecoveryExecution({ ...analysisIdentity, observedLeaseToken }),
    ).resolves.toEqual({ state: 'missing' })
    await expect(
      acquireWeeklyReportRecoveryExecution({ ...reportIdentity, observedLeaseToken }),
    ).resolves.toEqual({ state: 'missing' })
  })

  it.each(['not-a-uuid', '', '00000000-0000-0000-0000-00000000000z'])(
    'rejects invalid observed token %s before bypass or SQL',
    async (invalidToken) => {
      await expect(
        acquireAnswerAnalysisRecoveryExecution({
          ...analysisIdentity,
          observedLeaseToken: invalidToken,
        }),
      ).rejects.toThrow('Observed generation execution lease token must be a valid UUID.')
      expect(mocks.bypass).not.toHaveBeenCalled()
      expect(mocks.executeRaw).not.toHaveBeenCalled()
    },
  )
})
