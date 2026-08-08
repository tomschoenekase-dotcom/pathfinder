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
  enqueueAnswerAnalysisDispatch,
  enqueueGenerationDispatchKick,
  GENERATION_DISPATCH_QUEUE,
  getBullMQConnection,
} from './index'

function isExplicitDisposableRedis(): boolean {
  if (process.env.RUN_GENERATION_DISPATCH_REDIS_INTEGRATION !== '1') return false
  if (
    process.env.PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION !==
    'pathfinder_disposable_generation_dispatch'
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

integrationDescribe('generation dispatch enqueue identity (disposable Redis integration)', () => {
  let answerQueue!: Queue
  let dispatchQueue!: Queue
  const dispatchA = 'dispatch/opaque-A_123'
  const dispatchB = 'dispatch/opaque-B_456'
  const answerPayload = {
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    snapshotId: 'snapshot_1',
    rangeStart: '2026-08-01T00:00:00.000Z',
    rangeEnd: '2026-08-08T00:00:00.000Z',
  }

  beforeAll(async () => {
    answerQueue = new Queue(ANSWER_ANALYSIS_QUEUE, { connection: getBullMQConnection() })
    dispatchQueue = new Queue(GENERATION_DISPATCH_QUEUE, { connection: getBullMQConnection() })
    await Promise.all([
      answerQueue.obliterate({ force: true }),
      dispatchQueue.obliterate({ force: true }),
    ])
  })

  afterAll(async () => {
    await Promise.all([
      answerQueue.obliterate({ force: true }),
      dispatchQueue.obliterate({ force: true }),
    ])
    await Promise.all([answerQueue.close(), dispatchQueue.close()])
    await closeJobQueues()
    await closeBullMQConnection()
  })

  it('deduplicates 32 same-dispatch target adds and separates a distinct dispatch', async () => {
    await Promise.all(
      Array.from({ length: 32 }, () => enqueueAnswerAnalysisDispatch(answerPayload, dispatchA)),
    )
    let jobs = await answerQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])
    expect(jobs).toHaveLength(1)

    await enqueueAnswerAnalysisDispatch(answerPayload, dispatchB)
    jobs = await answerQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])
    expect(jobs).toHaveLength(2)
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2)
    expect(jobs.every((job) => job.name === 'answer-analysis-process')).toBe(true)
    expect(jobs.every((job) => JSON.stringify(job.data) === JSON.stringify(answerPayload))).toBe(
      true,
    )
  })

  it('deduplicates 32 same-dispatch kicks and separates a distinct dispatch', async () => {
    await Promise.all(Array.from({ length: 32 }, () => enqueueGenerationDispatchKick(dispatchA)))
    let jobs = await dispatchQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])
    expect(jobs).toHaveLength(1)

    await enqueueGenerationDispatchKick(dispatchB)
    jobs = await dispatchQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])
    expect(jobs).toHaveLength(2)
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2)
    expect(jobs.map((job) => job.data.dispatchId).sort()).toEqual([dispatchA, dispatchB].sort())
  })
})
