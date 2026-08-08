import { Queue } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'staging', REDIS_URL: process.env.REDIS_URL },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  ANSWER_ANALYSIS_QUEUE,
  closeBullMQConnection,
  closeJobQueues,
  enqueueAnswerAnalysisRecovery,
  enqueueWeeklyReportRecovery,
  getBullMQConnection,
  WEEKLY_REPORT_QUEUE,
} from './index'

function isExplicitDisposableRedis(): boolean {
  if (process.env.RUN_GENERATION_RECOVERY_REDIS_INTEGRATION !== '1') return false
  if (
    process.env.PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION !==
    'pathfinder_disposable_generation_recovery'
  ) {
    return false
  }
  try {
    const url = new URL(process.env.REDIS_URL ?? '')
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return (
      (url.protocol === 'redis:' || url.protocol === 'rediss:') &&
      ['127.0.0.1', '::1', 'localhost'].includes(host) &&
      url.port.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    )
  } catch {
    return false
  }
}

const integrationDescribe = isExplicitDisposableRedis() ? describe : describe.skip

integrationDescribe('generation recovery enqueue identity (disposable Redis integration)', () => {
  let answerQueue!: Queue
  let reportQueue!: Queue
  const tokenA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const tokenB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const answerPayload = {
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    snapshotId: 'snapshot_1',
    rangeStart: '2026-08-01T00:00:00.000Z',
    rangeEnd: '2026-08-08T00:00:00.000Z',
  }
  const reportPayload = {
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    reportId: 'report_1',
    weekStart: '2026-08-01T00:00:00.000Z',
    weekEnd: '2026-08-08T00:00:00.000Z',
  }

  beforeAll(async () => {
    answerQueue = new Queue(ANSWER_ANALYSIS_QUEUE, { connection: getBullMQConnection() })
    reportQueue = new Queue(WEEKLY_REPORT_QUEUE, { connection: getBullMQConnection() })
    await Promise.all([
      answerQueue.obliterate({ force: true }),
      reportQueue.obliterate({ force: true }),
    ])
  })

  afterAll(async () => {
    await Promise.all([
      answerQueue.obliterate({ force: true }),
      reportQueue.obliterate({ force: true }),
    ])
    await Promise.all([answerQueue.close(), reportQueue.close()])
    await closeJobQueues()
    await closeBullMQConnection()
  })

  it('deduplicates 32 same-token analysis requests and separates a takeover token', async () => {
    await Promise.all(
      Array.from({ length: 32 }, () => enqueueAnswerAnalysisRecovery(answerPayload, tokenA)),
    )
    let jobs = await answerQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])

    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      name: 'answer-analysis-recovery',
      data: { ...answerPayload, observedLeaseToken: tokenA },
    })

    await Promise.all(
      Array.from({ length: 32 }, () => enqueueAnswerAnalysisRecovery(answerPayload, tokenB)),
    )
    jobs = await answerQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])

    expect(jobs).toHaveLength(2)
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2)
  })

  it('deduplicates 32 same-token weekly-report recovery requests', async () => {
    await Promise.all(
      Array.from({ length: 32 }, () => enqueueWeeklyReportRecovery(reportPayload, tokenA)),
    )
    const jobs = await reportQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])

    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      name: 'weekly-report-recovery',
      data: { ...reportPayload, observedLeaseToken: tokenA },
    })
  })
})
