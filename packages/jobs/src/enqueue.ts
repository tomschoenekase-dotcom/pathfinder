import { Queue, type JobsOptions } from 'bullmq'

import { logger } from '@pathfinder/config'

import { getBullMQConnection } from './connection'
import {
  DAILY_ROLLUP_PROCESS_JOB,
  DAILY_ROLLUP_QUEUE,
  DAILY_ROLLUP_RETRY_BACKOFF,
  WEEKLY_DIGEST_PROCESS_JOB,
  WEEKLY_DIGEST_QUEUE,
  WEEKLY_DIGEST_RETRY_BACKOFF,
} from './queues'
import type { DailyRollupJobPayload, WeeklyDigestJobPayload } from './types'

const queueCache = new Map<string, Queue>()

function getQueue(name: string): Queue {
  const existingQueue = queueCache.get(name)

  if (existingQueue) {
    return existingQueue
  }

  const queue = new Queue(name, {
    connection: getBullMQConnection(),
  })

  queueCache.set(name, queue)

  return queue
}

const weeklyDigestJobOptions: JobsOptions = {
  attempts: 6,
  backoff: {
    type: WEEKLY_DIGEST_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

const dailyRollupJobOptions: JobsOptions = {
  attempts: 6,
  backoff: {
    type: DAILY_ROLLUP_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

export async function enqueueWeeklyDigest(payload: WeeklyDigestJobPayload): Promise<void> {
  await getQueue(WEEKLY_DIGEST_QUEUE).add(WEEKLY_DIGEST_PROCESS_JOB, payload, {
    ...weeklyDigestJobOptions,
    jobId: `weekly-digest:${payload.digestId}`,
  })

  logger.info({
    action: 'jobs.weekly-digest.enqueued',
    tenantId: payload.tenantId,
    digestId: payload.digestId,
    weekStart: payload.weekStart,
    weekEnd: payload.weekEnd,
  })
}

export async function enqueueDailyRollup(payload: DailyRollupJobPayload): Promise<void> {
  await getQueue(DAILY_ROLLUP_QUEUE).add(DAILY_ROLLUP_PROCESS_JOB, payload, {
    ...dailyRollupJobOptions,
    jobId: `daily-rollup:${payload.tenantId}:${payload.date}`,
  })

  logger.info({
    action: 'jobs.daily-rollup.enqueued',
    tenantId: payload.tenantId,
    date: payload.date,
  })
}

export async function closeJobQueues(): Promise<void> {
  const queues = Array.from(queueCache.values())
  queueCache.clear()

  await Promise.all(queues.map(async (queue) => queue.close()))
}
