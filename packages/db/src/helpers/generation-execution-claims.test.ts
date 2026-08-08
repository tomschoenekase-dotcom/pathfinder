import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  answerFindFirst: vi.fn(),
  reportFindFirst: vi.fn(),
}))

vi.mock('../client', () => ({
  db: {
    $executeRaw: mocks.executeRaw,
    answerAnalysisSnapshot: { findFirst: mocks.answerFindFirst },
    weeklyReport: { findFirst: mocks.reportFindFirst },
  },
}))

import {
  acquireAnswerAnalysisExecution,
  acquireWeeklyReportExecution,
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

describe('generation execution claims', () => {
  beforeEach(() => vi.clearAllMocks())

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
    expect(mocks.reportFindFirst).not.toHaveBeenCalled()
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
})
