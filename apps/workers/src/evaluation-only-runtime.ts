import { Queue, Worker, type Job } from 'bullmq'

import { logger } from '@pathfinder/config'
import {
  EVALUATION_RUN_DISPATCH_JOB,
  EVALUATION_RUN_PROCESS_JOB,
  EVALUATION_RUN_QUEUE,
  EVALUATION_RUN_RETRY_BACKOFF,
  GUEST_ANSWER_ATTRIBUTION_EVALUATION_PROCESS_JOB,
  GUEST_ANSWER_ATTRIBUTION_EVALUATION_QUEUE,
  GUEST_ANSWER_ATTRIBUTION_EVALUATION_RECOVERY_JOB,
  closeBullMQConnection,
  closeJobQueues,
  getBullMQConnection,
  type EvaluationRunJobPayload,
  type GuestAnswerAttributionEvaluationJobPayload,
} from '@pathfinder/jobs'

import { getJobExecutionMetadata } from './lib/job-execution'
import { runAiJobWithIncidentControl } from './lib/global-ai-deferral'
import { createShutdownCoordinator, runStartupWithCleanup } from './lib/worker-lifecycle'
import { processEvaluationDispatchJob } from './processors/evaluation-dispatch'
import { processEvaluationRunJob } from './processors/evaluation-run'
import {
  processGuestAnswerAttributionEvaluationJob,
  recoverGuestAnswerAttributionEvaluations,
} from './processors/guest-answer-attribution-evaluation'
import { applySchedulerState } from './scheduler-control'

function getEvaluationRunBackoffDelay(attemptsMade: number): number {
  return attemptsMade === 1 ? 30_000 : attemptsMade === 2 ? 2 * 60_000 : -1
}

async function handleEvaluationRunQueueJob(
  job: Job<EvaluationRunJobPayload | Record<string, never>>,
  token?: string,
  signal?: AbortSignal,
) {
  if (job.name === EVALUATION_RUN_DISPATCH_JOB) {
    await processEvaluationDispatchJob(getJobExecutionMetadata(job))
    return
  }
  if (job.name !== EVALUATION_RUN_PROCESS_JOB) {
    throw new Error(`Unsupported evaluation run job: ${job.name}`)
  }
  await runAiJobWithIncidentControl(job, token, () =>
    processEvaluationRunJob(
      job.data as EvaluationRunJobPayload,
      getJobExecutionMetadata(job),
      signal,
    ),
  )
}

async function handleGuestAnswerAttributionEvaluationQueueJob(
  job: Job<GuestAnswerAttributionEvaluationJobPayload | Record<string, never>>,
  token?: string,
  signal?: AbortSignal,
) {
  if (job.name === GUEST_ANSWER_ATTRIBUTION_EVALUATION_RECOVERY_JOB) {
    await recoverGuestAnswerAttributionEvaluations()
    return
  }
  if (job.name !== GUEST_ANSWER_ATTRIBUTION_EVALUATION_PROCESS_JOB) {
    throw new Error(`Unsupported guest answer attribution evaluation job: ${job.name}`)
  }
  await runAiJobWithIncidentControl(job, token, async () => {
    await processGuestAnswerAttributionEvaluationJob(
      job.data as GuestAnswerAttributionEvaluationJobPayload,
      signal,
    )
  })
}

function observeWorker(worker: Worker): Worker {
  worker.on('completed', (job) =>
    logger.info({
      action: 'workers.job.completed',
      jobId: job.id,
      jobName: job.name,
      queueName: job.queueName,
    }),
  )
  worker.on('failed', (job, error) =>
    logger.error({
      action: 'workers.job.failed',
      error: error.message,
      ...(job?.id ? { jobId: job.id } : {}),
      ...(job?.name ? { jobName: job.name } : {}),
      ...(job?.queueName ? { queueName: job.queueName } : {}),
    }),
  )
  worker.on('error', (error) =>
    logger.error({ action: 'workers.runtime.error', error: error.message }),
  )
  return worker
}

export async function startEvaluationOnlyRuntime() {
  const connection = getBullMQConnection()
  const evaluationRunQueue = new Queue(EVALUATION_RUN_QUEUE, { connection })
  const attributionQueue = new Queue(GUEST_ANSWER_ATTRIBUTION_EVALUATION_QUEUE, { connection })
  let evaluationRunWorker: Worker | null = null
  let attributionWorker: Worker | null = null

  const shutdown = createShutdownCoordinator({
    onStart: () => logger.info({ action: 'workers.shutdown', mode: 'evaluation-only' }),
    phases: [
      {
        name: 'workers',
        resources: [
          {
            name: EVALUATION_RUN_QUEUE,
            close: () => evaluationRunWorker?.close() ?? Promise.resolve(),
          },
          {
            name: GUEST_ANSWER_ATTRIBUTION_EVALUATION_QUEUE,
            close: () => attributionWorker?.close() ?? Promise.resolve(),
          },
        ],
      },
      {
        name: 'scheduler-queues',
        resources: [
          { name: EVALUATION_RUN_QUEUE, close: () => evaluationRunQueue.close() },
          {
            name: GUEST_ANSWER_ATTRIBUTION_EVALUATION_QUEUE,
            close: () => attributionQueue.close(),
          },
        ],
      },
      { name: 'enqueue-queues', resources: [{ name: 'cached', close: closeJobQueues }] },
      {
        name: 'connection',
        resources: [{ name: 'bullmq', close: closeBullMQConnection }],
      },
    ],
  })

  await runStartupWithCleanup(async () => {
    await applySchedulerState(true, [
      {
        upsert: () =>
          evaluationRunQueue.upsertJobScheduler(
            EVALUATION_RUN_DISPATCH_JOB,
            { every: 60_000 },
            {
              name: EVALUATION_RUN_DISPATCH_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: EVALUATION_RUN_RETRY_BACKOFF },
                removeOnComplete: 100,
                removeOnFail: 500,
              },
            },
          ),
        remove: () => evaluationRunQueue.removeJobScheduler(EVALUATION_RUN_DISPATCH_JOB),
      },
    ])
    await applySchedulerState(true, [
      {
        upsert: () =>
          attributionQueue.upsertJobScheduler(
            GUEST_ANSWER_ATTRIBUTION_EVALUATION_RECOVERY_JOB,
            { every: 60_000 },
            {
              name: GUEST_ANSWER_ATTRIBUTION_EVALUATION_RECOVERY_JOB,
              data: {},
              opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 500 },
            },
          ),
        remove: () =>
          attributionQueue.removeJobScheduler(GUEST_ANSWER_ATTRIBUTION_EVALUATION_RECOVERY_JOB),
      },
    ])

    evaluationRunWorker = observeWorker(
      new Worker(EVALUATION_RUN_QUEUE, handleEvaluationRunQueueJob, {
        connection,
        concurrency: 1,
        settings: {
          backoffStrategy: (attemptsMade, type) =>
            type === EVALUATION_RUN_RETRY_BACKOFF ? getEvaluationRunBackoffDelay(attemptsMade) : 0,
        },
      }),
    )
    attributionWorker = observeWorker(
      new Worker(
        GUEST_ANSWER_ATTRIBUTION_EVALUATION_QUEUE,
        handleGuestAnswerAttributionEvaluationQueueJob,
        { connection, concurrency: 1 },
      ),
    )
  }, shutdown)

  logger.info({
    action: 'workers.started',
    mode: 'evaluation-only',
    outboundProviderWorkersEnabled: false,
    evaluationRunnerEnabled: true,
    queues: [EVALUATION_RUN_QUEUE, GUEST_ANSWER_ATTRIBUTION_EVALUATION_QUEUE],
  })

  return {
    mode: 'evaluation-only' as const,
    queues: [EVALUATION_RUN_QUEUE, GUEST_ANSWER_ATTRIBUTION_EVALUATION_QUEUE] as const,
    shutdown,
  }
}
