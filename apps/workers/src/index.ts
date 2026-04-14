import { Queue, Worker, type Job } from 'bullmq'

import { logger } from '@pathfinder/config'
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import {
  closeBullMQConnection,
  closeJobQueues,
  DAILY_ROLLUP_PROCESS_JOB,
  DAILY_ROLLUP_QUEUE,
  DAILY_ROLLUP_RETRY_BACKOFF,
  DAILY_ROLLUP_SCHEDULER_JOB,
  enqueueDailyRollup,
  enqueueWeeklyDigest,
  getBullMQConnection,
  WEEKLY_DIGEST_PROCESS_JOB,
  WEEKLY_DIGEST_QUEUE,
  WEEKLY_DIGEST_RETRY_BACKOFF,
  WEEKLY_DIGEST_SCHEDULER_JOB,
  type DailyRollupJobPayload,
  type WeeklyDigestJobPayload,
} from '@pathfinder/jobs'

import { processDailyRollupJob } from './processors/daily-rollup'
import { processWeeklyDigestJob } from './processors/weekly-digest'

const WEEKLY_DIGEST_CRON = '0 23 * * 0'
const DAILY_ROLLUP_CRON = '0 1 * * *'

function startOfUtcWeek(date: Date): Date {
  const start = new Date(date)
  const day = start.getUTCDay()
  const daysFromMonday = (day + 6) % 7

  start.setUTCDate(start.getUTCDate() - daysFromMonday)
  start.setUTCHours(0, 0, 0, 0)

  return start
}

function endOfUtcWeek(date: Date): Date {
  const end = new Date(startOfUtcWeek(date))

  end.setUTCDate(end.getUTCDate() + 6)
  end.setUTCHours(23, 59, 59, 999)

  return end
}

function getWeeklyDigestBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    case 3:
      return 5 * 60_000
    case 4:
      return 30 * 60_000
    case 5:
      return 2 * 60 * 60_000
    default:
      return -1
  }
}

function startOfUtcDay(date: Date): Date {
  const result = new Date(date)

  result.setUTCHours(0, 0, 0, 0)

  return result
}

function getDailyRollupBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    case 3:
      return 5 * 60_000
    case 4:
      return 30 * 60_000
    case 5:
      return 2 * 60 * 60_000
    default:
      return -1
  }
}

async function enqueueScheduledWeeklyDigests(): Promise<void> {
  const now = new Date()
  const weekStart = startOfUtcWeek(now)
  const weekEnd = endOfUtcWeek(now)
  const activeTenants = await db.tenant.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
  })

  for (const tenant of activeTenants) {
    const digest = await withTenantIsolationBypass(async () => {
      const existingDigest = await db.weeklyDigest.findUnique({
        where: {
          tenantId_weekStart: {
            tenantId: tenant.id,
            weekStart,
          },
        },
        select: {
          id: true,
          status: true,
        },
      })

      if (existingDigest?.status === 'COMPLETE' || existingDigest?.status === 'PROCESSING') {
        return existingDigest
      }

      if (existingDigest) {
        return db.weeklyDigest.update({
          where: { id: existingDigest.id },
          data: {
            status: 'PENDING',
            weekEnd,
            sessionCount: 0,
            messageCount: 0,
            insights: [],
            generatedAt: null,
          },
          select: {
            id: true,
            status: true,
          },
        })
      }

      return db.weeklyDigest.create({
        data: {
          tenantId: tenant.id,
          weekStart,
          weekEnd,
          status: 'PENDING',
        },
        select: {
          id: true,
          status: true,
        },
      })
    })

    if (digest.status === 'COMPLETE' || digest.status === 'PROCESSING') {
      continue
    }

    await enqueueWeeklyDigest({
      tenantId: tenant.id,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      digestId: digest.id,
    })
  }

  logger.info({
    action: 'workers.weekly-digest.scheduler.completed',
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    tenantCount: activeTenants.length,
  })
}

async function enqueueScheduledDailyRollups(): Promise<void> {
  const yesterday = startOfUtcDay(new Date())
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)

  const activeTenants = await db.tenant.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
  })

  for (const tenant of activeTenants) {
    await enqueueDailyRollup({
      tenantId: tenant.id,
      date: yesterday.toISOString(),
    })
  }

  logger.info({
    action: 'workers.daily-rollup.scheduler.completed',
    date: yesterday.toISOString(),
    tenantCount: activeTenants.length,
  })
}

async function handleWeeklyDigestQueueJob(
  job: Job<WeeklyDigestJobPayload | Record<string, never>>,
) {
  if (job.name === WEEKLY_DIGEST_SCHEDULER_JOB) {
    await enqueueScheduledWeeklyDigests()
    return
  }

  if (job.name === WEEKLY_DIGEST_PROCESS_JOB) {
    await processWeeklyDigestJob(job.data as WeeklyDigestJobPayload, job.id)
    return
  }

  throw new Error(`Unsupported weekly digest job: ${job.name}`)
}

async function handleDailyRollupQueueJob(job: Job<DailyRollupJobPayload | Record<string, never>>) {
  if (job.name === DAILY_ROLLUP_SCHEDULER_JOB) {
    await enqueueScheduledDailyRollups()
    return
  }

  if (job.name === DAILY_ROLLUP_PROCESS_JOB) {
    await processDailyRollupJob(job.data as DailyRollupJobPayload, job.id)
    return
  }

  throw new Error(`Unsupported daily rollup job: ${job.name}`)
}

export async function startWorkers() {
  const connection = getBullMQConnection()
  const weeklyDigestQueue = new Queue(WEEKLY_DIGEST_QUEUE, { connection })
  const dailyRollupQueue = new Queue(DAILY_ROLLUP_QUEUE, { connection })

  await weeklyDigestQueue.upsertJobScheduler(
    WEEKLY_DIGEST_SCHEDULER_JOB,
    {
      pattern: WEEKLY_DIGEST_CRON,
    },
    {
      name: WEEKLY_DIGEST_SCHEDULER_JOB,
      data: {},
      opts: {
        removeOnComplete: 10,
        removeOnFail: 50,
      },
    },
  )

  await dailyRollupQueue.upsertJobScheduler(
    DAILY_ROLLUP_SCHEDULER_JOB,
    {
      pattern: DAILY_ROLLUP_CRON,
    },
    {
      name: DAILY_ROLLUP_SCHEDULER_JOB,
      data: {},
      opts: {
        removeOnComplete: 10,
        removeOnFail: 50,
      },
    },
  )

  const weeklyDigestWorker = new Worker(WEEKLY_DIGEST_QUEUE, handleWeeklyDigestQueueJob, {
    connection,
    concurrency: 2,
    settings: {
      backoffStrategy: (attemptsMade, type) => {
        if (type === WEEKLY_DIGEST_RETRY_BACKOFF) {
          return getWeeklyDigestBackoffDelay(attemptsMade)
        }

        return 0
      },
    },
  })

  const dailyRollupWorker = new Worker(DAILY_ROLLUP_QUEUE, handleDailyRollupQueueJob, {
    connection,
    concurrency: 2,
    settings: {
      backoffStrategy: (attemptsMade, type) => {
        if (type === DAILY_ROLLUP_RETRY_BACKOFF) {
          return getDailyRollupBackoffDelay(attemptsMade)
        }

        return 0
      },
    },
  })

  const handleCompletedJob = (job: Job) => {
    logger.info({
      action: 'workers.job.completed',
      jobId: job.id,
      jobName: job.name,
      queueName: job.queueName,
    })
  }

  const handleFailedJob = (job: Job | undefined, error: Error) => {
    logger.error({
      action: 'workers.job.failed',
      error: error.message,
      ...(job?.id ? { jobId: job.id } : {}),
      ...(job?.name ? { jobName: job.name } : {}),
      ...(job?.queueName ? { queueName: job.queueName } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    })
  }

  weeklyDigestWorker.on('completed', handleCompletedJob)
  dailyRollupWorker.on('completed', handleCompletedJob)

  weeklyDigestWorker.on('failed', handleFailedJob)
  dailyRollupWorker.on('failed', handleFailedJob)

  logger.info({
    action: 'workers.started',
    queues: [WEEKLY_DIGEST_QUEUE, DAILY_ROLLUP_QUEUE],
  })

  const shutdown = async () => {
    logger.info({ action: 'workers.shutdown' })

    await Promise.allSettled([
      weeklyDigestWorker.close(),
      dailyRollupWorker.close(),
      weeklyDigestQueue.close(),
      dailyRollupQueue.close(),
      closeJobQueues(),
      closeBullMQConnection(),
    ])
  }

  process.once('SIGINT', () => {
    void shutdown()
  })

  process.once('SIGTERM', () => {
    void shutdown()
  })

  return {
    dailyRollupQueue,
    dailyRollupWorker,
    weeklyDigestQueue,
    weeklyDigestWorker,
    shutdown,
  }
}

if (require.main === module) {
  void startWorkers().catch((error: unknown) => {
    logger.error({
      action: 'workers.start.failed',
      error: error instanceof Error ? error.message : 'Unknown worker startup error',
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })

    process.exitCode = 1
  })
}
