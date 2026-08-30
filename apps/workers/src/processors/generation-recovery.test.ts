import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  enqueueAnswer: vi.fn(),
  enqueueReport: vi.fn(),
  writeJobRecord: vi.fn(),
  updateJobRecord: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  logger: {
    info: mocks.loggerInfo,
    error: mocks.loggerError,
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))
vi.mock('@pathfinder/db', () => ({
  discoverExpiredGenerationExecutions: mocks.discover,
  GENERATION_RECOVERY_MAX_PER_TYPE: 50,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))
vi.mock('@pathfinder/jobs', () => ({
  enqueueAnswerAnalysisRecovery: mocks.enqueueAnswer,
  enqueueWeeklyReportRecovery: mocks.enqueueReport,
  GENERATION_RECOVERY_QUEUE: 'staging--generation-recovery',
  GENERATION_RECOVERY_SCHEDULER_JOB: 'generation-recovery-scheduler',
}))

import { processGenerationRecovery } from './generation-recovery'

const rangeStart = new Date('2026-08-01T00:00:00.000Z')
const rangeEnd = new Date('2026-08-08T00:00:00.000Z')
const analysis = {
  snapshotId: 'snapshot_1',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  rangeStart,
  rangeEnd,
  executionLeaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
const report = {
  reportId: 'report_1',
  tenantId: 'tenant_2',
  venueId: 'venue_2',
  weekStart: rangeStart,
  weekEnd: rangeEnd,
  executionLeaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}

describe('processGenerationRecovery', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.writeJobRecord.mockResolvedValue('job_record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.discover.mockResolvedValue({ answerAnalyses: [], weeklyReports: [] })
    mocks.enqueueAnswer.mockResolvedValue(undefined)
    mocks.enqueueReport.mockResolvedValue(undefined)
  })

  it('writes a platform JobRecord and enqueues every exact expired identity', async () => {
    mocks.discover.mockResolvedValueOnce({
      answerAnalyses: [analysis],
      weeklyReports: [report],
    })

    await expect(
      processGenerationRecovery({
        bullJobId: 'scheduler_job_1',
        attemptNumber: 1,
        maxAttempts: 3,
      }),
    ).resolves.toEqual({ discovered: 2, enqueueRequestsAccepted: 2, failed: 0 })

    expect(mocks.writeJobRecord).toHaveBeenCalledWith({
      queue: 'staging--generation-recovery',
      jobName: 'generation-recovery-scheduler',
      bullJobId: 'scheduler_job_1',
      tenantId: null,
      status: 'RUNNING',
      payload: { limitPerType: 50 },
      startedAt: expect.any(Date),
      attemptNumber: 1,
      maxAttempts: 3,
    })
    expect(mocks.enqueueAnswer).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        snapshotId: 'snapshot_1',
        rangeStart: rangeStart.toISOString(),
        rangeEnd: rangeEnd.toISOString(),
      },
      analysis.executionLeaseToken,
    )
    expect(mocks.enqueueReport).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_2',
        venueId: 'venue_2',
        reportId: 'report_1',
        weekStart: rangeStart.toISOString(),
        weekEnd: rangeEnd.toISOString(),
      },
      report.executionLeaseToken,
    )
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
    expect(mocks.loggerInfo).toHaveBeenCalledWith({
      action: 'workers.generation-recovery.completed',
      discovered: 2,
      enqueueRequestsAccepted: 2,
      failed: 0,
    })
  })

  it('completes truthfully for an empty bounded scan', async () => {
    await expect(processGenerationRecovery()).resolves.toEqual({
      discovered: 0,
      enqueueRequestsAccepted: 0,
      failed: 0,
    })
    expect(mocks.enqueueAnswer).not.toHaveBeenCalled()
    expect(mocks.enqueueReport).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('continues after one enqueue failure, records a sanitized failure, and throws for retry', async () => {
    const secondAnalysis = { ...analysis, snapshotId: 'snapshot_2' }
    mocks.discover.mockResolvedValueOnce({
      answerAnalyses: [analysis, secondAnalysis],
      weeklyReports: [report],
    })
    mocks.enqueueAnswer.mockRejectedValueOnce(
      new Error('redis://user:secret@internal.example unavailable'),
    )

    await expect(
      processGenerationRecovery({
        bullJobId: 'scheduler_job_2',
        attemptNumber: 2,
        maxAttempts: 3,
      }),
    ).rejects.toThrow('Failed to enqueue 1 generation recovery candidate(s).')

    expect(mocks.enqueueAnswer).toHaveBeenCalledTimes(2)
    expect(mocks.enqueueReport).toHaveBeenCalledOnce()
    expect(mocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_1',
      expect.objectContaining({
        status: 'FAILED',
        error: 'JOB_RETRY_ELIGIBLE',
        attemptNumber: 2,
        maxAttempts: 3,
        failureDisposition: 'RETRY_ELIGIBLE',
      }),
    )
    const serializedLogs = JSON.stringify(mocks.loggerError.mock.calls)
    expect(serializedLogs).not.toContain('secret')
    expect(serializedLogs).not.toContain('internal.example')
    expect(serializedLogs).not.toContain(analysis.executionLeaseToken)
  })

  it('records a sanitized discovery failure and preserves the original error for BullMQ', async () => {
    const discoveryError = new Error('postgresql://user:secret@internal.example unavailable')
    mocks.discover.mockRejectedValueOnce(discoveryError)

    await expect(processGenerationRecovery()).rejects.toBe(discoveryError)
    expect(mocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_1',
      expect.objectContaining({
        status: 'FAILED',
        error: 'JOB_ATTEMPTS_EXHAUSTED',
      }),
    )
    const serializedLogs = JSON.stringify(mocks.loggerError.mock.calls)
    expect(serializedLogs).not.toContain('secret')
    expect(serializedLogs).not.toContain('internal.example')
  })
})
