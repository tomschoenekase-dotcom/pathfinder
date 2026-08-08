import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  instances: new Map<string, { add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>(),
  queue: vi.fn(),
  loggerInfo: vi.fn(),
}))

vi.mock('bullmq', () => ({
  Queue: mocks.queue.mockImplementation((name: string) => {
    const instance = { add: mocks.add, close: vi.fn(async () => undefined) }
    mocks.instances.set(name, instance)
    return instance
  }),
}))
vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'test', REDIS_URL: 'redis://unused' },
  logger: { info: mocks.loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('./connection', () => ({ getBullMQConnection: vi.fn(() => ({})) }))

import {
  closeJobQueues,
  enqueueAnswerAnalysis,
  enqueueAnswerAnalysisRecovery,
  enqueueEmbedKnowledgeEntry,
  enqueueEmbedPlace,
  enqueueMediaIngestion,
  enqueueWelcomeEmail,
  enqueueWeeklyReport,
  enqueueWeeklyReportRecovery,
} from './enqueue'

const LEASE_TOKEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LEASE_TOKEN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const answerAnalysisPayload = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  snapshotId: 'snapshot_1',
  rangeStart: '2026-08-01T00:00:00.000Z',
  rangeEnd: '2026-08-08T00:00:00.000Z',
}
const weeklyReportPayload = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  reportId: 'report_1',
  weekStart: '2026-08-01T00:00:00.000Z',
  weekEnd: '2026-08-08T00:00:00.000Z',
}

describe('job enqueues', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.add.mockResolvedValue({ id: 'generated' })
  })

  afterEach(async () => {
    for (const instance of mocks.instances.values()) instance.close.mockResolvedValue(undefined)
    await closeJobQueues()
    mocks.instances.clear()
  })

  it('does not suppress repeated place revisions with a retained entity job id', async () => {
    const payload = {
      tenantId: 'tenant_1',
      placeId: 'place_1',
      contentUpdatedAt: '2026-08-07T18:00:00.123Z',
    }
    await enqueueEmbedPlace(payload)
    await enqueueEmbedPlace(payload)

    expect(mocks.add).toHaveBeenCalledTimes(2)
    for (const call of mocks.add.mock.calls) {
      expect(call[2]).not.toHaveProperty('jobId')
    }
  })

  it('closes every cached queue and retains only failures for retry', async () => {
    await enqueueEmbedPlace({
      tenantId: 'tenant_1',
      placeId: 'place_1',
      contentUpdatedAt: '2026-08-07T18:00:00.123Z',
    })
    await enqueueEmbedKnowledgeEntry({
      tenantId: 'tenant_1',
      entryId: 'entry_1',
      contentUpdatedAt: '2026-08-07T18:00:00.123Z',
    })
    const placeQueue = Array.from(mocks.instances.entries()).find(([name]) =>
      name.endsWith('embed-place'),
    )![1]
    const knowledgeQueue = Array.from(mocks.instances.entries()).find(([name]) =>
      name.endsWith('embed-knowledge-entry'),
    )![1]
    knowledgeQueue.close.mockRejectedValueOnce(new Error('redis unavailable'))

    const error = await closeJobQueues().catch((failure: unknown) => failure)
    expect(placeQueue.close).toHaveBeenCalledOnce()
    expect(knowledgeQueue.close).toHaveBeenCalledOnce()
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toMatchObject([
      { message: expect.stringMatching(/embed-knowledge-entry: redis unavailable$/u) },
    ])

    await closeJobQueues()
    expect(placeQueue.close).toHaveBeenCalledOnce()
    expect(knowledgeQueue.close).toHaveBeenCalledTimes(2)
  })

  it('does not suppress repeated knowledge revisions with a retained entity job id', async () => {
    const payload = {
      tenantId: 'tenant_1',
      entryId: 'entry_1',
      contentUpdatedAt: '2026-08-07T18:00:00.123Z',
    }
    await enqueueEmbedKnowledgeEntry(payload)
    await enqueueEmbedKnowledgeEntry(payload)

    expect(mocks.add).toHaveBeenCalledTimes(2)
    for (const call of mocks.add.mock.calls) {
      expect(call[2]).not.toHaveProperty('jobId')
    }
  })

  it('deduplicates only the exact opaque media-ingestion generation', async () => {
    const payload = {
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
      uploadAttemptId: '11111111-1111-4111-8111-111111111111',
    }
    await enqueueMediaIngestion(payload)
    await enqueueMediaIngestion(payload)
    await enqueueMediaIngestion({
      ...payload,
      uploadAttemptId: '22222222-2222-4222-8222-222222222222',
    })

    expect(mocks.add).toHaveBeenCalledTimes(3)
    const [first, replay, nextGeneration] = mocks.add.mock.calls
    expect(replay![2].jobId).toBe(first![2].jobId)
    expect(nextGeneration![2].jobId).not.toBe(first![2].jobId)
    expect(first![2].jobId).toMatch(/^media-ingestion-[a-f0-9]{64}$/u)
    expect(first![2].jobId).not.toContain(payload.tenantId)
    expect(first![2].jobId).not.toContain(payload.projectId)
    expect(first![2].jobId).not.toContain(payload.uploadAttemptId)
    expect(first![1]).toEqual(payload)
  })

  it('scopes welcome-email deduplication to the tenant and recipient without leaking user ID', async () => {
    const payload = {
      tenantId: 'tenant_1',
      to: 'recipient@example.com',
      recipientName: 'Recipient',
      orgName: 'Test Org',
    }

    await enqueueWelcomeEmail(payload, 'user_1')
    await enqueueWelcomeEmail(payload, 'user_2')
    await enqueueWelcomeEmail(payload, 'user_1')
    await enqueueWelcomeEmail({ ...payload, tenantId: 'tenant_2' }, 'user_1')

    expect(mocks.add).toHaveBeenCalledTimes(4)
    const [first, second, retry, otherTenant] = mocks.add.mock.calls
    expect(first![2].jobId).not.toBe(second![2].jobId)
    expect(retry![2].jobId).toBe(first![2].jobId)
    expect(otherTenant![2].jobId).not.toBe(first![2].jobId)
    expect(first![2].jobId).toMatch(/^send-welcome-email-[a-f0-9]{64}$/u)
    expect(JSON.stringify(mocks.add.mock.calls)).not.toContain('user_1')
    expect(JSON.stringify(mocks.add.mock.calls)).not.toContain('user_2')
    expect(first![1]).toEqual(payload)
  })

  it('rejects a missing welcome recipient identity before touching the queue', async () => {
    await expect(
      enqueueWelcomeEmail(
        {
          tenantId: 'tenant_1',
          to: 'recipient@example.com',
          recipientName: null,
          orgName: 'Test Org',
        },
        '',
      ),
    ).rejects.toThrow('recipient user ID is required')
    expect(mocks.add).not.toHaveBeenCalled()
  })

  it.each([
    ['answer analysis', () => enqueueAnswerAnalysisRecovery(answerAnalysisPayload, 'not-a-uuid')],
    ['weekly report', () => enqueueWeeklyReportRecovery(weeklyReportPayload, 'not-a-uuid')],
  ])('rejects an invalid %s recovery token before opening a queue', async (_label, enqueue) => {
    await expect(enqueue()).rejects.toThrow('Observed execution lease token must be a UUID')
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
    expect(mocks.loggerInfo).not.toHaveBeenCalled()
  })

  it('derives stable, token-separated, type-separated opaque recovery job IDs', async () => {
    await enqueueAnswerAnalysisRecovery(answerAnalysisPayload, LEASE_TOKEN_A)
    await enqueueAnswerAnalysisRecovery(answerAnalysisPayload, LEASE_TOKEN_A.toUpperCase())
    await enqueueAnswerAnalysisRecovery(answerAnalysisPayload, LEASE_TOKEN_B)
    await enqueueWeeklyReportRecovery(
      { ...weeklyReportPayload, reportId: answerAnalysisPayload.snapshotId },
      LEASE_TOKEN_A,
    )
    await enqueueAnswerAnalysis(answerAnalysisPayload)
    await enqueueWeeklyReport(weeklyReportPayload)

    const [
      answerFirst,
      answerReplay,
      answerTakeover,
      reportRecovery,
      answerOrdinary,
      reportOrdinary,
    ] = mocks.add.mock.calls
    const answerRecoveryId = answerFirst![2].jobId as string
    const reportRecoveryId = reportRecovery![2].jobId as string

    expect(answerReplay![2].jobId).toBe(answerRecoveryId)
    expect(answerTakeover![2].jobId).not.toBe(answerRecoveryId)
    expect(reportRecoveryId).not.toBe(answerRecoveryId)
    expect(answerOrdinary![2].jobId).not.toBe(answerRecoveryId)
    expect(reportOrdinary![2].jobId).not.toBe(reportRecoveryId)
    expect(answerRecoveryId).toMatch(/^generation-recovery-answer-analysis-[a-f0-9]{64}$/u)
    expect(reportRecoveryId).toMatch(/^generation-recovery-weekly-report-[a-f0-9]{64}$/u)
    expect(answerRecoveryId).not.toContain(answerAnalysisPayload.snapshotId)
    expect(answerRecoveryId).not.toContain(LEASE_TOKEN_A)
    expect(reportRecoveryId).not.toContain(weeklyReportPayload.reportId)
    expect(reportRecoveryId).not.toContain(LEASE_TOKEN_A)
  })

  it('uses a token-fenced answer-analysis recovery payload with ordinary retry options', async () => {
    await enqueueAnswerAnalysisRecovery(answerAnalysisPayload, LEASE_TOKEN_A)

    expect(mocks.add).toHaveBeenCalledWith(
      'answer-analysis-recovery',
      { ...answerAnalysisPayload, observedLeaseToken: LEASE_TOKEN_A },
      expect.objectContaining({
        attempts: 6,
        backoff: { type: 'answer-analysis-retry' },
        removeOnComplete: 1000,
        removeOnFail: 5000,
        jobId: expect.stringMatching(/^generation-recovery-answer-analysis-[a-f0-9]{64}$/u),
      }),
    )
  })

  it('uses a token-fenced weekly-report recovery payload with ordinary retry options', async () => {
    await enqueueWeeklyReportRecovery(weeklyReportPayload, LEASE_TOKEN_A)

    expect(mocks.add).toHaveBeenCalledWith(
      'weekly-report-recovery',
      { ...weeklyReportPayload, observedLeaseToken: LEASE_TOKEN_A },
      expect.objectContaining({
        attempts: 6,
        backoff: { type: 'weekly-report-retry' },
        removeOnComplete: 1000,
        removeOnFail: 5000,
        jobId: expect.stringMatching(/^generation-recovery-weekly-report-[a-f0-9]{64}$/u),
      }),
    )
  })

  it('logs recovery enqueue outcomes without lease tokens or digest identity inputs', async () => {
    await enqueueAnswerAnalysisRecovery(answerAnalysisPayload, LEASE_TOKEN_A)
    await enqueueWeeklyReportRecovery(weeklyReportPayload, LEASE_TOKEN_B)

    expect(mocks.loggerInfo.mock.calls).toEqual([
      [{ action: 'jobs.answer-analysis.recovery-enqueued' }],
      [{ action: 'jobs.weekly-report.recovery-enqueued' }],
    ])
    const serializedLogs = JSON.stringify(mocks.loggerInfo.mock.calls)
    for (const sensitive of [
      LEASE_TOKEN_A,
      LEASE_TOKEN_B,
      ...Object.values(answerAnalysisPayload),
      ...Object.values(weeklyReportPayload),
    ]) {
      expect(serializedLogs).not.toContain(sensitive)
    }
  })
})
