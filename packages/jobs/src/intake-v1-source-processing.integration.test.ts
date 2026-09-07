import { Queue, Worker } from 'bullmq'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'staging', REDIS_URL: process.env.REDIS_URL },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  closeBullMQConnection,
  closeJobQueues,
  enqueueIntakeV1SourceProcessing,
  getBullMQConnection,
  INTAKE_V1_SOURCE_PROCESSING_PROCESS_JOB,
  INTAKE_V1_SOURCE_PROCESSING_QUEUE,
} from './index'

function isExplicitDisposableRedis(): boolean {
  if (process.env.RUN_INTAKE_V1_SOURCE_PROCESSING_REDIS_INTEGRATION !== '1') return false
  if (
    process.env.PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION !==
    'pathfinder_disposable_intake_v1_source_processing'
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

integrationDescribe('V1 source-processing wake-up lifecycle (disposable Redis integration)', () => {
  let queue!: Queue

  beforeAll(async () => {
    queue = new Queue(INTAKE_V1_SOURCE_PROCESSING_QUEUE, { connection: getBullMQConnection() })
    await queue.obliterate({ force: true })
  })

  beforeEach(async () => {
    // Each lifecycle case uses the same stable job-ID domain. Clearing this
    // explicitly prevents a waiting wake-up from one case being consumed by
    // the next case's worker.
    await queue.obliterate({ force: true })
  })

  afterAll(async () => {
    await queue.obliterate({ force: true })
    await queue.close()
    await closeJobQueues()
    await closeBullMQConnection()
  })

  it('removes a completed stable wake-up so the next durable sweep produces runnable work', async () => {
    const worker = new Worker(INTAKE_V1_SOURCE_PROCESSING_QUEUE, async () => undefined, {
      connection: getBullMQConnection(),
    })
    const completed = new Promise<void>((resolve) => worker.once('completed', () => resolve()))
    await enqueueIntakeV1SourceProcessing('dispatch-completed')
    await completed
    await worker.close()

    expect(await queue.getJobCountByTypes('completed', 'failed', 'waiting', 'active')).toBe(0)
    await enqueueIntakeV1SourceProcessing('dispatch-completed')
    const waiting = await queue.getWaiting()
    expect(waiting).toHaveLength(1)
    expect(waiting[0]?.name).toBe(INTAKE_V1_SOURCE_PROCESSING_PROCESS_JOB)
  }, 30_000)

  it('removes an exhausted failed wake-up so an expired durable lease can be woken again', async () => {
    const worker = new Worker(
      INTAKE_V1_SOURCE_PROCESSING_QUEUE,
      async () => {
        throw new Error('synthetic transport failure')
      },
      { connection: getBullMQConnection() },
    )
    const failed = new Promise<void>((resolve) =>
      worker.on('failed', (job, error) => {
        if (job?.attemptsMade === 3 && error.message === 'synthetic transport failure') resolve()
      }),
    )
    await enqueueIntakeV1SourceProcessing('dispatch-failed')
    await failed
    await worker.close()

    expect(await queue.getJobCountByTypes('completed', 'failed', 'waiting', 'active')).toBe(0)
    await enqueueIntakeV1SourceProcessing('dispatch-failed')
    expect(await queue.getWaiting()).toHaveLength(1)
  }, 30_000)
})
