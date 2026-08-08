import IORedis from 'ioredis'
import { Queue, QueueEvents, Worker } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'preview', REDIS_URL: process.env.REDIS_URL },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  closeBullMQConnection,
  configureMediaIngestionGlobalConcurrency,
  getBullMQConnection,
  MEDIA_INGESTION_GLOBAL_CONCURRENCY,
  MEDIA_INGESTION_QUEUE,
} from './index'

function isExplicitDisposableRedis(): boolean {
  if (process.env.RUN_MEDIA_ADMISSION_REDIS_INTEGRATION !== '1') return false
  if (
    process.env.PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION !== 'pathfinder_disposable_media_admission'
  ) {
    return false
  }

  try {
    const url = new URL(process.env.REDIS_URL ?? '')
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return (
      url.protocol === 'redis:' &&
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

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
        timeout.unref?.()
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

integrationDescribe('media ingestion global admission (disposable Redis integration)', () => {
  let queue!: Queue
  let queueEvents!: QueueEvents

  beforeAll(async () => {
    queue = new Queue(MEDIA_INGESTION_QUEUE, { connection: getBullMQConnection() })
    queueEvents = new QueueEvents(MEDIA_INGESTION_QUEUE, { connection: getBullMQConnection() })
    await Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady()])
    await queue.obliterate({ force: true })
  })

  afterAll(async () => {
    await queue.removeGlobalConcurrency()
    await queue.obliterate({ force: true })
    await Promise.all([queueEvents.close(), queue.close()])
    await closeBullMQConnection()
  })

  it('serializes handlers across two independently connected workers', async () => {
    await configureMediaIngestionGlobalConcurrency(queue)

    const connectionA = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null })
    const connectionB = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null })
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let reportFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      reportFirstStarted = resolve
    })
    const handlerIdentities: string[] = []
    let activeHandlers = 0
    let maximumActiveHandlers = 0

    const handler = (identity: string) => async () => {
      activeHandlers += 1
      handlerIdentities.push(identity)
      maximumActiveHandlers = Math.max(maximumActiveHandlers, activeHandlers)
      try {
        if (handlerIdentities.length === 1) {
          reportFirstStarted()
          await firstRelease
        }
      } finally {
        activeHandlers -= 1
      }
    }

    const workerA = new Worker(MEDIA_INGESTION_QUEUE, handler('A'), {
      autorun: false,
      concurrency: 1,
      connection: connectionA,
    })
    const workerB = new Worker(MEDIA_INGESTION_QUEUE, handler('B'), {
      autorun: false,
      concurrency: 1,
      connection: connectionB,
    })

    let runA: Promise<void> | undefined
    let runB: Promise<void> | undefined
    try {
      const jobs = await Promise.all([
        queue.add('media-ingestion-process', { generation: 'a' }),
        queue.add('media-ingestion-process', { generation: 'b' }),
        queue.add('media-ingestion-process', { generation: 'c' }),
      ])
      runA = workerA.run()
      await within(firstStarted, 5_000, 'first media worker start')
      await workerB.waitUntilReady()

      expect(await workerB.getNextJob('blocked-admission-probe', { block: false })).toBeUndefined()
      expect(handlerIdentities).toEqual(['A'])
      expect(await queue.getActiveCount()).toBe(1)

      await workerA.pause(true)
      releaseFirst()
      runB = workerB.run()
      await Promise.all(jobs.map((job) => job.waitUntilFinished(queueEvents, 10_000)))
      expect(handlerIdentities).toHaveLength(3)
      expect(new Set(handlerIdentities)).toEqual(new Set(['A', 'B']))
      expect(maximumActiveHandlers).toBe(1)
    } finally {
      releaseFirst()
      await Promise.all([workerA.close(true), workerB.close(true)])
      await Promise.all([runA, runB].filter((run): run is Promise<void> => run !== undefined))
      await Promise.all([connectionA.quit(), connectionB.quit()])
    }
  }, 20_000)

  it('persists idempotently and remains isolated from the production queue name', async () => {
    await configureMediaIngestionGlobalConcurrency(queue)
    await configureMediaIngestionGlobalConcurrency(queue)

    const observer = new Queue(MEDIA_INGESTION_QUEUE, { connection: getBullMQConnection() })
    const productionQueue = new Queue('media-ingestion', { connection: getBullMQConnection() })
    try {
      expect(await observer.getGlobalConcurrency()).toBe(MEDIA_INGESTION_GLOBAL_CONCURRENCY)
      expect(await productionQueue.getGlobalConcurrency()).toBeNull()
    } finally {
      await Promise.all([observer.close(), productionQueue.close()])
    }
  })
})
