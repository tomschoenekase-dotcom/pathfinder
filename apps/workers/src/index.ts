import { Queue, Worker, type Job } from 'bullmq'

import { assertServerEnv, env, logger } from '@pathfinder/config'
import {
  ANSWER_ANALYSIS_PROCESS_JOB,
  ANSWER_ANALYSIS_QUEUE,
  ANSWER_ANALYSIS_RECOVERY_JOB,
  ANSWER_ANALYSIS_RETRY_BACKOFF,
  ANALYTICS_ENRICHMENT_PROCESS_JOB,
  ANALYTICS_ENRICHMENT_QUEUE,
  ANALYTICS_ENRICHMENT_RETRY_BACKOFF,
  ANALYTICS_ENRICHMENT_SCHEDULER_JOB,
  closeBullMQConnection,
  closeJobQueues,
  configureMediaIngestionGlobalConcurrency,
  DAILY_ROLLUP_PROCESS_JOB,
  DAILY_ROLLUP_QUEUE,
  DAILY_ROLLUP_RETRY_BACKOFF,
  DAILY_ROLLUP_SCHEDULER_JOB,
  EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB,
  EMBED_KNOWLEDGE_ENTRY_QUEUE,
  EMBED_KNOWLEDGE_ENTRY_RETRY_BACKOFF,
  EMBED_PLACE_PROCESS_JOB,
  EMBED_PLACE_QUEUE,
  EMBED_PLACE_RETRY_BACKOFF,
  EMBEDDING_DISPATCH_QUEUE,
  EMBEDDING_DISPATCH_SCHEDULER_JOB,
  GENERATION_DISPATCH_KICK_JOB,
  GENERATION_DISPATCH_QUEUE,
  GENERATION_DISPATCH_SCHEDULER_JOB,
  GENERATION_RECOVERY_QUEUE,
  GENERATION_RECOVERY_SCHEDULER_JOB,
  getBullMQConnection,
  MEDIA_INGESTION_PROCESS_JOB,
  MEDIA_INGESTION_QUEUE,
  MEDIA_INGESTION_RETRY_BACKOFF,
  SEND_EMAIL_QUEUE,
  SEND_WELCOME_EMAIL_JOB,
  SEND_WELCOME_EMAIL_RETRY_BACKOFF,
  type AnalyticsEnrichmentJobPayload,
  type EmbedKnowledgeEntryJobPayload,
  type EmbedPlaceJobPayload,
  type GenerationDispatchKickJobPayload,
  type SendWelcomeEmailJobPayload,
  WEEKLY_DIGEST_PROCESS_JOB,
  WEEKLY_DIGEST_QUEUE,
  WEEKLY_DIGEST_RETRY_BACKOFF,
  WEEKLY_DIGEST_SCHEDULER_JOB,
  WEEKLY_REPORT_PROCESS_JOB,
  WEEKLY_REPORT_QUEUE,
  WEEKLY_REPORT_RECOVERY_JOB,
  WEEKLY_REPORT_RETRY_BACKOFF,
  type AnswerAnalysisJobPayload,
  type AnswerAnalysisRecoveryJobPayload,
  type DailyRollupJobPayload,
  type WeeklyDigestJobPayload,
  type WeeklyReportJobPayload,
  type WeeklyReportRecoveryJobPayload,
  type MediaIngestionJobPayload,
} from '@pathfinder/jobs'

import { processAnswerAnalysisJob } from './processors/answer-analysis'
import { processAnalyticsEnrichmentJob } from './processors/analytics-enrichment'
import { processDailyRollupJob } from './processors/daily-rollup'
import { processEmbedKnowledgeEntryJob } from './processors/embed-knowledge-entry'
import { processEmbedPlaceJob } from './processors/embed-place'
import { processEmbeddingDispatches } from './processors/dispatch-embeddings'
import { processGenerationDispatches } from './processors/generation-dispatch'
import { processGenerationRecovery } from './processors/generation-recovery'
import { processSendWelcomeEmailJob } from './processors/send-welcome-email'
import { processWeeklyDigestJob } from './processors/weekly-digest'
import { processWeeklyReportJob } from './processors/weekly-report'
import { processMediaIngestionJob } from './processors/media-ingestion'
import { applySchedulerState, utcCronSchedule } from './scheduler-control'
import {
  enqueueScheduledAnalyticsEnrichment,
  enqueueScheduledDailyRollups,
  enqueueScheduledWeeklyDigests,
} from './scheduled-tenant-fanout'
import { getJobExecutionMetadata } from './lib/job-execution'
import { globalAiAdmissionAvailable, runAiJobWithIncidentControl } from './lib/global-ai-deferral'
import {
  cancelAllMediaJobsAfterWorkerError,
  cancelMediaJobsAfterLockRenewalFailure,
} from './lib/media-job-cancellation'
import { createMediaAttemptSignal } from './lib/media-attempt-limits'
import {
  createEscalatingShutdownHandler,
  createShutdownCoordinator,
  runStartupWithCleanup,
} from './lib/worker-lifecycle'

const WEEKLY_DIGEST_CRON = '0 23 * * 0'
const DAILY_ROLLUP_CRON = '0 1 * * *'
// Runs after the daily rollup (01:00) so its pure-SQL rows already exist.
const ANALYTICS_ENRICHMENT_CRON = '30 1 * * *'
const EMBEDDING_DISPATCH_CRON = '* * * * *'
const GENERATION_DISPATCH_CRON = '* * * * *'
const GENERATION_RECOVERY_CRON = '* * * * *'

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

function getEmbedPlaceBackoffDelay(attemptsMade: number): number {
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

function getEmbedKnowledgeEntryBackoffDelay(attemptsMade: number): number {
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

function getAnalyticsEnrichmentBackoffDelay(attemptsMade: number): number {
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

function getAnswerAnalysisBackoffDelay(attemptsMade: number): number {
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

function getWeeklyReportBackoffDelay(attemptsMade: number): number {
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

function getSendWelcomeEmailBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    default:
      return -1
  }
}

async function handleWeeklyDigestQueueJob(
  job: Job<WeeklyDigestJobPayload | Record<string, never>>,
  token?: string,
) {
  if (job.name === WEEKLY_DIGEST_SCHEDULER_JOB) {
    if (!(await globalAiAdmissionAvailable())) return
    await enqueueScheduledWeeklyDigests()
    return
  }

  if (job.name === WEEKLY_DIGEST_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processWeeklyDigestJob(job.data as WeeklyDigestJobPayload, getJobExecutionMetadata(job)),
    )
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
    await processDailyRollupJob(job.data as DailyRollupJobPayload, getJobExecutionMetadata(job))
    return
  }

  throw new Error(`Unsupported daily rollup job: ${job.name}`)
}

async function handleEmbedPlaceQueueJob(job: Job<EmbedPlaceJobPayload>, token?: string) {
  if (job.name === EMBED_PLACE_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processEmbedPlaceJob(job.data, getJobExecutionMetadata(job)),
    )
    return
  }

  throw new Error(`Unsupported embed place job: ${job.name}`)
}

async function handleEmbedKnowledgeEntryQueueJob(
  job: Job<EmbedKnowledgeEntryJobPayload>,
  token?: string,
) {
  if (job.name === EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processEmbedKnowledgeEntryJob(job.data, getJobExecutionMetadata(job)),
    )
    return
  }

  throw new Error(`Unsupported embed knowledge entry job: ${job.name}`)
}

async function handleEmbeddingDispatchQueueJob(job: Job<Record<string, never>>) {
  if (job.name === EMBEDDING_DISPATCH_SCHEDULER_JOB) {
    if (!(await globalAiAdmissionAvailable())) return
    await processEmbeddingDispatches()
    return
  }

  throw new Error(`Unsupported embedding dispatch job: ${job.name}`)
}

async function handleGenerationDispatchQueueJob(
  job: Job<GenerationDispatchKickJobPayload | Record<string, never>>,
  token?: string,
) {
  if (job.name === GENERATION_DISPATCH_SCHEDULER_JOB) {
    if (!(await globalAiAdmissionAvailable())) return
    await processGenerationDispatches()
    return
  }

  if (job.name === GENERATION_DISPATCH_KICK_JOB) {
    await runAiJobWithIncidentControl(job, token, async () => {
      await processGenerationDispatches()
    })
    return
  }

  throw new Error(`Unsupported generation dispatch job: ${job.name}`)
}

async function handleGenerationRecoveryQueueJob(job: Job<Record<string, never>>) {
  if (job.name === GENERATION_RECOVERY_SCHEDULER_JOB) {
    if (!(await globalAiAdmissionAvailable())) return
    await processGenerationRecovery(getJobExecutionMetadata(job))
    return
  }

  throw new Error(`Unsupported generation recovery job: ${job.name}`)
}

async function handleAnalyticsEnrichmentQueueJob(
  job: Job<AnalyticsEnrichmentJobPayload | Record<string, never>>,
  token?: string,
) {
  if (job.name === ANALYTICS_ENRICHMENT_SCHEDULER_JOB) {
    if (!(await globalAiAdmissionAvailable())) return
    await enqueueScheduledAnalyticsEnrichment()
    return
  }

  if (job.name === ANALYTICS_ENRICHMENT_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processAnalyticsEnrichmentJob(
        job.data as AnalyticsEnrichmentJobPayload,
        getJobExecutionMetadata(job),
      ),
    )
    return
  }

  throw new Error(`Unsupported analytics enrichment job: ${job.name}`)
}

async function handleAnswerAnalysisQueueJob(
  job: Job<AnswerAnalysisJobPayload | AnswerAnalysisRecoveryJobPayload>,
  token?: string,
) {
  if (job.name === ANSWER_ANALYSIS_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processAnswerAnalysisJob(job.data, getJobExecutionMetadata(job)),
    )
    return
  }

  if (job.name === ANSWER_ANALYSIS_RECOVERY_JOB) {
    const { observedLeaseToken, ...payload } = job.data as AnswerAnalysisRecoveryJobPayload
    await runAiJobWithIncidentControl(job, token, () =>
      processAnswerAnalysisJob(payload, getJobExecutionMetadata(job), { observedLeaseToken }),
    )
    return
  }

  throw new Error(`Unsupported answer analysis job: ${job.name}`)
}

async function handleWeeklyReportQueueJob(
  job: Job<WeeklyReportJobPayload | WeeklyReportRecoveryJobPayload>,
  token?: string,
) {
  if (job.name === WEEKLY_REPORT_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processWeeklyReportJob(job.data, getJobExecutionMetadata(job)),
    )
    return
  }

  if (job.name === WEEKLY_REPORT_RECOVERY_JOB) {
    const { observedLeaseToken, ...payload } = job.data as WeeklyReportRecoveryJobPayload
    await runAiJobWithIncidentControl(job, token, () =>
      processWeeklyReportJob(payload, getJobExecutionMetadata(job), { observedLeaseToken }),
    )
    return
  }

  throw new Error(`Unsupported weekly report job: ${job.name}`)
}

async function handleSendEmailQueueJob(job: Job<SendWelcomeEmailJobPayload>) {
  if (job.name === SEND_WELCOME_EMAIL_JOB) {
    await processSendWelcomeEmailJob(job.data, getJobExecutionMetadata(job))
    return
  }

  throw new Error(`Unsupported send-email job: ${job.name}`)
}

async function handleMediaIngestionQueueJob(
  job: Job<MediaIngestionJobPayload>,
  token?: string,
  signal?: AbortSignal,
) {
  if (job.name === MEDIA_INGESTION_PROCESS_JOB) {
    const attempt = createMediaAttemptSignal(signal)
    try {
      await runAiJobWithIncidentControl(job, token, () =>
        processMediaIngestionJob(job.data, getJobExecutionMetadata(job), attempt.signal),
      )
    } finally {
      attempt.dispose()
    }
    return
  }

  throw new Error(`Unsupported media ingestion job: ${job.name}`)
}

export async function startWorkers() {
  const connection = getBullMQConnection()
  const weeklyDigestQueue = new Queue(WEEKLY_DIGEST_QUEUE, { connection })
  const dailyRollupQueue = new Queue(DAILY_ROLLUP_QUEUE, { connection })
  const embedPlaceQueue = new Queue(EMBED_PLACE_QUEUE, { connection })
  const embeddingDispatchQueue = new Queue(EMBEDDING_DISPATCH_QUEUE, { connection })
  const generationDispatchQueue = new Queue(GENERATION_DISPATCH_QUEUE, { connection })
  const generationRecoveryQueue = new Queue(GENERATION_RECOVERY_QUEUE, { connection })
  const analyticsEnrichmentQueue = new Queue(ANALYTICS_ENRICHMENT_QUEUE, { connection })
  const answerAnalysisQueue = new Queue(ANSWER_ANALYSIS_QUEUE, { connection })
  const weeklyReportQueue = new Queue(WEEKLY_REPORT_QUEUE, { connection })
  const mediaIngestionQueue = new Queue(MEDIA_INGESTION_QUEUE, { connection })

  const schedulerQueueResources = [
    { name: WEEKLY_DIGEST_QUEUE, close: () => weeklyDigestQueue.close() },
    { name: DAILY_ROLLUP_QUEUE, close: () => dailyRollupQueue.close() },
    { name: EMBED_PLACE_QUEUE, close: () => embedPlaceQueue.close() },
    { name: EMBEDDING_DISPATCH_QUEUE, close: () => embeddingDispatchQueue.close() },
    { name: GENERATION_DISPATCH_QUEUE, close: () => generationDispatchQueue.close() },
    { name: GENERATION_RECOVERY_QUEUE, close: () => generationRecoveryQueue.close() },
    { name: ANALYTICS_ENRICHMENT_QUEUE, close: () => analyticsEnrichmentQueue.close() },
    { name: ANSWER_ANALYSIS_QUEUE, close: () => answerAnalysisQueue.close() },
    { name: WEEKLY_REPORT_QUEUE, close: () => weeklyReportQueue.close() },
    { name: MEDIA_INGESTION_QUEUE, close: () => mediaIngestionQueue.close() },
  ]
  const cleanupAfterStartupFailure = createShutdownCoordinator({
    onStart: () => logger.info({ action: 'workers.start.cleanup' }),
    phases: [
      { name: 'scheduler-queues', resources: schedulerQueueResources },
      { name: 'enqueue-queues', resources: [{ name: 'cached', close: closeJobQueues }] },
      {
        name: 'connection',
        resources: [{ name: 'bullmq', close: closeBullMQConnection }],
      },
    ],
  })

  await runStartupWithCleanup(async () => {
    await configureMediaIngestionGlobalConcurrency(mediaIngestionQueue)

    await applySchedulerState(env.WORKER_SCHEDULERS_ENABLED, [
      {
        upsert: () =>
          weeklyDigestQueue.upsertJobScheduler(
            WEEKLY_DIGEST_SCHEDULER_JOB,
            utcCronSchedule(WEEKLY_DIGEST_CRON),
            {
              name: WEEKLY_DIGEST_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 10,
                removeOnFail: 50,
              },
            },
          ),
        remove: () => weeklyDigestQueue.removeJobScheduler(WEEKLY_DIGEST_SCHEDULER_JOB),
      },
      {
        upsert: () =>
          dailyRollupQueue.upsertJobScheduler(
            DAILY_ROLLUP_SCHEDULER_JOB,
            utcCronSchedule(DAILY_ROLLUP_CRON),
            {
              name: DAILY_ROLLUP_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 10,
                removeOnFail: 50,
              },
            },
          ),
        remove: () => dailyRollupQueue.removeJobScheduler(DAILY_ROLLUP_SCHEDULER_JOB),
      },
      {
        upsert: () =>
          analyticsEnrichmentQueue.upsertJobScheduler(
            ANALYTICS_ENRICHMENT_SCHEDULER_JOB,
            utcCronSchedule(ANALYTICS_ENRICHMENT_CRON),
            {
              name: ANALYTICS_ENRICHMENT_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 10,
                removeOnFail: 50,
              },
            },
          ),
        remove: () =>
          analyticsEnrichmentQueue.removeJobScheduler(ANALYTICS_ENRICHMENT_SCHEDULER_JOB),
      },
    ])

    await applySchedulerState(env.EMBEDDING_DISPATCH_ENABLED, [
      {
        upsert: () =>
          embeddingDispatchQueue.upsertJobScheduler(
            EMBEDDING_DISPATCH_SCHEDULER_JOB,
            { pattern: EMBEDDING_DISPATCH_CRON },
            {
              name: EMBEDDING_DISPATCH_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 10,
                removeOnFail: 50,
              },
            },
          ),
        remove: () => embeddingDispatchQueue.removeJobScheduler(EMBEDDING_DISPATCH_SCHEDULER_JOB),
      },
    ])

    await applySchedulerState(env.GENERATION_DISPATCH_ENABLED, [
      {
        upsert: () =>
          generationDispatchQueue.upsertJobScheduler(
            GENERATION_DISPATCH_SCHEDULER_JOB,
            { pattern: GENERATION_DISPATCH_CRON },
            {
              name: GENERATION_DISPATCH_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 10,
                removeOnFail: 50,
              },
            },
          ),
        remove: () => generationDispatchQueue.removeJobScheduler(GENERATION_DISPATCH_SCHEDULER_JOB),
      },
    ])

    await applySchedulerState(env.GENERATION_RECOVERY_ENABLED, [
      {
        upsert: () =>
          generationRecoveryQueue.upsertJobScheduler(
            GENERATION_RECOVERY_SCHEDULER_JOB,
            { pattern: GENERATION_RECOVERY_CRON },
            {
              name: GENERATION_RECOVERY_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 10,
                removeOnFail: 50,
              },
            },
          ),
        remove: () => generationRecoveryQueue.removeJobScheduler(GENERATION_RECOVERY_SCHEDULER_JOB),
      },
    ])
  }, cleanupAfterStartupFailure)

  const observeWorkerRuntime = <DataType, ResultType, NameType extends string>(
    queueName: string,
    worker: Worker<DataType, ResultType, NameType>,
  ) => {
    worker.on('error', (error) => {
      logger.error({
        action: 'workers.runtime.error',
        queueName,
        error: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      })
    })
    return worker
  }

  const weeklyDigestWorker = observeWorkerRuntime(
    WEEKLY_DIGEST_QUEUE,
    new Worker(WEEKLY_DIGEST_QUEUE, handleWeeklyDigestQueueJob, {
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
    }),
  )

  const dailyRollupWorker = observeWorkerRuntime(
    DAILY_ROLLUP_QUEUE,
    new Worker(DAILY_ROLLUP_QUEUE, handleDailyRollupQueueJob, {
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
    }),
  )

  const embedPlaceWorker = observeWorkerRuntime(
    EMBED_PLACE_QUEUE,
    new Worker(EMBED_PLACE_QUEUE, handleEmbedPlaceQueueJob, {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === EMBED_PLACE_RETRY_BACKOFF) {
            return getEmbedPlaceBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  const embedKnowledgeEntryWorker = observeWorkerRuntime(
    EMBED_KNOWLEDGE_ENTRY_QUEUE,
    new Worker(EMBED_KNOWLEDGE_ENTRY_QUEUE, handleEmbedKnowledgeEntryQueueJob, {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === EMBED_KNOWLEDGE_ENTRY_RETRY_BACKOFF) {
            return getEmbedKnowledgeEntryBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  const embeddingDispatchWorker = observeWorkerRuntime(
    EMBEDDING_DISPATCH_QUEUE,
    new Worker(EMBEDDING_DISPATCH_QUEUE, handleEmbeddingDispatchQueueJob, {
      connection,
      concurrency: 1,
    }),
  )

  // Keep kick consumption active even when recurring dispatch scans are disabled.
  const generationDispatchWorker = observeWorkerRuntime(
    GENERATION_DISPATCH_QUEUE,
    new Worker(GENERATION_DISPATCH_QUEUE, handleGenerationDispatchQueueJob, {
      connection,
      concurrency: 1,
    }),
  )

  const generationRecoveryWorker = observeWorkerRuntime(
    GENERATION_RECOVERY_QUEUE,
    new Worker(GENERATION_RECOVERY_QUEUE, handleGenerationRecoveryQueueJob, {
      connection,
      concurrency: 1,
    }),
  )

  const analyticsEnrichmentWorker = observeWorkerRuntime(
    ANALYTICS_ENRICHMENT_QUEUE,
    new Worker(ANALYTICS_ENRICHMENT_QUEUE, handleAnalyticsEnrichmentQueueJob, {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === ANALYTICS_ENRICHMENT_RETRY_BACKOFF) {
            return getAnalyticsEnrichmentBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  const sendEmailWorker = observeWorkerRuntime(
    SEND_EMAIL_QUEUE,
    new Worker(SEND_EMAIL_QUEUE, handleSendEmailQueueJob, {
      connection,
      concurrency: 4,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === SEND_WELCOME_EMAIL_RETRY_BACKOFF) {
            return getSendWelcomeEmailBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  const answerAnalysisWorker = observeWorkerRuntime(
    ANSWER_ANALYSIS_QUEUE,
    new Worker(ANSWER_ANALYSIS_QUEUE, handleAnswerAnalysisQueueJob, {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === ANSWER_ANALYSIS_RETRY_BACKOFF) {
            return getAnswerAnalysisBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  const weeklyReportWorker = observeWorkerRuntime(
    WEEKLY_REPORT_QUEUE,
    new Worker(WEEKLY_REPORT_QUEUE, handleWeeklyReportQueueJob, {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === WEEKLY_REPORT_RETRY_BACKOFF) {
            return getWeeklyReportBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  // A media job may hold several GB of temporary data and make many model calls.
  // The queue-global ceiling configured above serializes every worker replica;
  // local concurrency remains one as a second, process-level boundary.
  const mediaIngestionWorker = observeWorkerRuntime(
    MEDIA_INGESTION_QUEUE,
    new Worker(MEDIA_INGESTION_QUEUE, handleMediaIngestionQueueJob, {
      connection,
      concurrency: 1,
      settings: {
        backoffStrategy: (attemptsMade, type) =>
          type === MEDIA_INGESTION_RETRY_BACKOFF ? Math.min(attemptsMade * 60_000, 5 * 60_000) : 0,
      },
    }),
  )
  mediaIngestionWorker.on('lockRenewalFailed', (jobIds) => {
    const cancelled = cancelMediaJobsAfterLockRenewalFailure(mediaIngestionWorker, jobIds)
    logger.error({
      action: 'media-ingestion.lock-renewal-failed',
      affectedJobs: jobIds.length,
      cancelledJobs: cancelled,
      error: 'Worker lost one or more media job locks.',
    })
  })
  mediaIngestionWorker.on('error', () => {
    cancelAllMediaJobsAfterWorkerError(mediaIngestionWorker)
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

  const workers = [
    { name: WEEKLY_DIGEST_QUEUE, worker: weeklyDigestWorker },
    { name: DAILY_ROLLUP_QUEUE, worker: dailyRollupWorker },
    { name: EMBED_PLACE_QUEUE, worker: embedPlaceWorker },
    { name: EMBED_KNOWLEDGE_ENTRY_QUEUE, worker: embedKnowledgeEntryWorker },
    { name: EMBEDDING_DISPATCH_QUEUE, worker: embeddingDispatchWorker },
    { name: GENERATION_DISPATCH_QUEUE, worker: generationDispatchWorker },
    { name: GENERATION_RECOVERY_QUEUE, worker: generationRecoveryWorker },
    { name: ANALYTICS_ENRICHMENT_QUEUE, worker: analyticsEnrichmentWorker },
    { name: SEND_EMAIL_QUEUE, worker: sendEmailWorker },
    { name: ANSWER_ANALYSIS_QUEUE, worker: answerAnalysisWorker },
    { name: WEEKLY_REPORT_QUEUE, worker: weeklyReportWorker },
    { name: MEDIA_INGESTION_QUEUE, worker: mediaIngestionWorker },
  ]

  for (const { worker } of workers) {
    worker.on('completed', handleCompletedJob)
    worker.on('failed', handleFailedJob)
  }

  logger.info({
    action: 'workers.started',
    recurringSchedulersEnabled: env.WORKER_SCHEDULERS_ENABLED,
    embeddingDispatchEnabled: env.EMBEDDING_DISPATCH_ENABLED,
    generationDispatchEnabled: env.GENERATION_DISPATCH_ENABLED,
    generationRecoveryEnabled: env.GENERATION_RECOVERY_ENABLED,
    queues: [
      WEEKLY_DIGEST_QUEUE,
      DAILY_ROLLUP_QUEUE,
      EMBED_PLACE_QUEUE,
      EMBED_KNOWLEDGE_ENTRY_QUEUE,
      EMBEDDING_DISPATCH_QUEUE,
      GENERATION_DISPATCH_QUEUE,
      GENERATION_RECOVERY_QUEUE,
      ANALYTICS_ENRICHMENT_QUEUE,
      ANSWER_ANALYSIS_QUEUE,
      WEEKLY_REPORT_QUEUE,
      SEND_EMAIL_QUEUE,
      MEDIA_INGESTION_QUEUE,
    ],
  })

  const shutdown = createShutdownCoordinator({
    onStart: () => logger.info({ action: 'workers.shutdown' }),
    phases: [
      {
        name: 'workers',
        resources: workers.map(({ name, worker }) => ({ name, close: () => worker.close() })),
      },
      {
        name: 'scheduler-queues',
        resources: schedulerQueueResources,
      },
      {
        name: 'enqueue-queues',
        resources: [{ name: 'cached', close: closeJobQueues }],
      },
      {
        name: 'connection',
        resources: [{ name: 'bullmq', close: closeBullMQConnection }],
      },
    ],
  })

  const handleShutdownSignal = createEscalatingShutdownHandler(
    shutdown,
    (error) => {
      logger.error({
        action: 'workers.shutdown.failed',
        error: error instanceof Error ? error.message : 'Unknown worker shutdown error',
        ...(error instanceof AggregateError
          ? {
              failures: error.errors.map((failure) =>
                failure instanceof Error ? failure.message : 'Unknown resource close error',
              ),
            }
          : {}),
      })
      process.exitCode = 1
    },
    () => {
      logger.error({
        action: 'workers.shutdown.forced',
        error: 'Forced worker shutdown after a second termination signal.',
        reason: 'second-signal',
      })
      process.exit(1)
    },
  )

  process.once('SIGINT', handleShutdownSignal)
  process.once('SIGTERM', handleShutdownSignal)

  return {
    analyticsEnrichmentQueue,
    analyticsEnrichmentWorker,
    answerAnalysisQueue,
    answerAnalysisWorker,
    dailyRollupQueue,
    dailyRollupWorker,
    embedKnowledgeEntryWorker,
    embeddingDispatchQueue,
    embeddingDispatchWorker,
    generationDispatchQueue,
    generationDispatchWorker,
    generationRecoveryQueue,
    generationRecoveryWorker,
    embedPlaceQueue,
    embedPlaceWorker,
    sendEmailWorker,
    mediaIngestionQueue,
    mediaIngestionWorker,
    weeklyReportQueue,
    weeklyReportWorker,
    weeklyDigestQueue,
    weeklyDigestWorker,
    shutdown,
  }
}

if (require.main === module) {
  void (async () => {
    try {
      // Fail fast on deploy if a key this process needs is missing, rather than
      // letting a scheduled job silently break hours later.
      assertServerEnv(['REDIS_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], 'workers')
      await startWorkers()
    } catch (error: unknown) {
      logger.error({
        action: 'workers.start.failed',
        error: error instanceof Error ? error.message : 'Unknown worker startup error',
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      })

      process.exitCode = 1
    }
  })()
}
