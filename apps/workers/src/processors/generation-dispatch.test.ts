import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  adoptLegacy: vi.fn(),
  defer: vi.fn(),
  enqueueAnswer: vi.fn(),
  enqueueReport: vi.fn(),
  fail: vi.fn(),
  lease: vi.fn(),
  settleProgressed: vi.fn(),
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
  adoptLegacyNullLeaseGenerationDispatches: mocks.adoptLegacy,
  deferGenerationRequestDispatch: mocks.defer,
  failGenerationRequestDispatch: mocks.fail,
  leaseGenerationRequestDispatches: mocks.lease,
  settleProgressedGenerationRequestDispatch: mocks.settleProgressed,
}))
vi.mock('@pathfinder/jobs', () => ({
  enqueueAnswerAnalysisDispatch: mocks.enqueueAnswer,
  enqueueWeeklyReportDispatch: mocks.enqueueReport,
}))

import { processGenerationDispatches } from './generation-dispatch'

const rangeStart = new Date('2026-08-01T00:00:00.000Z')
const rangeEnd = new Date('2026-08-08T00:00:00.000Z')
const answerDispatch = {
  id: 'dispatch_answer_1',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  kind: 'ANSWER_ANALYSIS' as const,
  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  requestHash: 'answer-hash',
  recordId: 'snapshot_1',
  rangeStart,
  rangeEnd,
  answerAnalysisSnapshotId: 'snapshot_1',
  weeklyReportId: null,
}
const reportDispatch = {
  id: 'dispatch_report_1',
  tenantId: 'tenant_2',
  venueId: 'venue_2',
  kind: 'WEEKLY_REPORT' as const,
  requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  requestHash: 'report-hash',
  recordId: 'report_1',
  rangeStart,
  rangeEnd,
  answerAnalysisSnapshotId: null,
  weeklyReportId: 'report_1',
}

describe('processGenerationDispatches', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.adoptLegacy.mockResolvedValue({ answerAnalysis: 0, weeklyReports: 0 })
    mocks.lease.mockResolvedValue({ leaseToken: 'lease_1', dispatches: [] })
    mocks.settleProgressed.mockResolvedValue(false)
    mocks.enqueueAnswer.mockResolvedValue(undefined)
    mocks.enqueueReport.mockResolvedValue(undefined)
    mocks.defer.mockResolvedValue(true)
    mocks.fail.mockResolvedValue(true)
  })

  it('adopts bounded legacy work, enqueues exact targets, and defers accepted dispatches', async () => {
    mocks.adoptLegacy.mockResolvedValueOnce({ answerAnalysis: 2, weeklyReports: 1 })
    mocks.lease.mockResolvedValueOnce({
      leaseToken: 'lease_1',
      dispatches: [answerDispatch, reportDispatch],
    })

    await expect(processGenerationDispatches()).resolves.toEqual({
      adopted: 3,
      leased: 2,
      progressed: 0,
      enqueueRequestsAccepted: 2,
      deferred: 2,
      failed: 0,
      superseded: 0,
    })
    expect(mocks.adoptLegacy).toHaveBeenCalledWith()
    expect(mocks.enqueueAnswer).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        snapshotId: 'snapshot_1',
        rangeStart: rangeStart.toISOString(),
        rangeEnd: rangeEnd.toISOString(),
      },
      'dispatch_answer_1',
    )
    expect(mocks.enqueueReport).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_2',
        venueId: 'venue_2',
        reportId: 'report_1',
        weekStart: rangeStart.toISOString(),
        weekEnd: rangeEnd.toISOString(),
      },
      'dispatch_report_1',
    )
    expect(mocks.defer).toHaveBeenNthCalledWith(1, {
      id: 'dispatch_answer_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      kind: 'ANSWER_ANALYSIS',
      recordId: 'snapshot_1',
      leaseToken: 'lease_1',
    })
    expect(mocks.fail).not.toHaveBeenCalled()
  })

  it('settles already-progressed targets without enqueueing them', async () => {
    mocks.lease.mockResolvedValueOnce({ leaseToken: 'lease_1', dispatches: [answerDispatch] })
    mocks.settleProgressed.mockResolvedValueOnce(true)

    await expect(processGenerationDispatches()).resolves.toEqual({
      adopted: 0,
      leased: 1,
      progressed: 1,
      enqueueRequestsAccepted: 0,
      deferred: 0,
      failed: 0,
      superseded: 0,
    })
    expect(mocks.enqueueAnswer).not.toHaveBeenCalled()
    expect(mocks.defer).not.toHaveBeenCalled()
  })

  it('retains an enqueue failure with a bounded sanitized error and continues the batch', async () => {
    mocks.lease.mockResolvedValueOnce({
      leaseToken: 'lease_1',
      dispatches: [answerDispatch, reportDispatch],
    })
    mocks.enqueueAnswer.mockRejectedValueOnce(
      new Error('redis://user:secret@internal.example unavailable'),
    )

    await expect(processGenerationDispatches()).resolves.toEqual({
      adopted: 0,
      leased: 2,
      progressed: 0,
      enqueueRequestsAccepted: 1,
      deferred: 1,
      failed: 1,
      superseded: 0,
    })
    expect(mocks.fail).toHaveBeenCalledWith({
      id: 'dispatch_answer_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      kind: 'ANSWER_ANALYSIS',
      recordId: 'snapshot_1',
      leaseToken: 'lease_1',
      error: 'Generation dispatch attempt failed.',
    })
    expect(mocks.enqueueReport).toHaveBeenCalledOnce()
    const persistedAndLogged = JSON.stringify([mocks.fail.mock.calls, mocks.loggerError.mock.calls])
    expect(persistedAndLogged).not.toContain('secret')
    expect(persistedAndLogged).not.toContain('internal.example')
  })

  it('rejects a mismatched target shape before queue publication', async () => {
    mocks.lease.mockResolvedValueOnce({
      leaseToken: 'lease_1',
      dispatches: [{ ...answerDispatch, answerAnalysisSnapshotId: 'snapshot_other' }],
    })

    await expect(processGenerationDispatches()).resolves.toEqual(
      expect.objectContaining({ failed: 1, enqueueRequestsAccepted: 0 }),
    )
    expect(mocks.enqueueAnswer).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Generation dispatch attempt failed.' }),
    )
  })

  it('fails the Bull delivery safely when dispatch failure state cannot be persisted', async () => {
    mocks.lease.mockResolvedValueOnce({ leaseToken: 'lease_1', dispatches: [answerDispatch] })
    mocks.enqueueAnswer.mockRejectedValueOnce(
      new Error('redis://user:secret@internal.example unavailable'),
    )
    mocks.fail.mockRejectedValueOnce(
      new Error('postgresql://user:secret@internal.example unavailable'),
    )

    await expect(processGenerationDispatches()).rejects.toThrow(
      'Generation dispatch failure state could not be persisted.',
    )
    const serializedLogs = JSON.stringify(mocks.loggerError.mock.calls)
    expect(serializedLogs).not.toContain('secret')
    expect(serializedLogs).not.toContain('internal.example')
    expect(mocks.loggerInfo).not.toHaveBeenCalled()
  })

  it('counts a lost exact lease as superseded without overwriting newer state', async () => {
    mocks.lease.mockResolvedValueOnce({ leaseToken: 'lease_1', dispatches: [answerDispatch] })
    mocks.defer.mockResolvedValueOnce(false)

    await expect(processGenerationDispatches()).resolves.toEqual(
      expect.objectContaining({ enqueueRequestsAccepted: 1, deferred: 0, superseded: 1 }),
    )
    expect(mocks.fail).not.toHaveBeenCalled()
  })
})
