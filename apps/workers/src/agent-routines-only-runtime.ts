import { Queue, Worker, type Job } from 'bullmq'

import { logger } from '@pathfinder/config'
import { db } from '@pathfinder/db'
import {
  AGENT_ROUTINE_DISPATCH_SCHEDULER_JOB,
  AGENT_ROUTINE_MAINTENANCE_QUEUE,
  closeBullMQConnection,
  getBullMQConnection,
} from '@pathfinder/jobs'

import { checkProviderDisabledRedis } from './lib/provider-disabled-redis'
import { startProviderDisabledRuntime } from './lib/provider-disabled-runtime'
import { queueSafeJobProcessor } from './lib/job-execution'
import { startIsolatedRuntimeReadinessHeartbeat } from './lib/isolated-runtime-readiness'
import { createShutdownCoordinator, runStartupWithCleanup } from './lib/worker-lifecycle'
import { processAgentRoutineDispatch } from './processors/agent-routine-dispatch'
import { applySchedulerState } from './scheduler-control'

async function handleAgentRoutineMaintenanceJob(job: Job<Record<string, never>>) {
  if (job.name !== AGENT_ROUTINE_DISPATCH_SCHEDULER_JOB) {
    throw new Error(`Unsupported agent routine maintenance job: ${job.name}`)
  }
  await processAgentRoutineDispatch()
}

/**
 * The only provider-dark runtime that schedules generic agent routines. It
 * owns one maintenance queue and one DB-backed dispatcher; it never starts
 * the broad provider worker graph or any model consumer.
 */
export async function startAgentRoutinesOnlyRuntime() {
  const redisUrl = process.env.REDIS_URL!
  const connectivity = await startProviderDisabledRuntime({
    checkConnection: () => checkProviderDisabledRedis(redisUrl, 5_000),
    closeConnection: async () => undefined,
    onConnectionError: () =>
      process.stderr.write(
        `${JSON.stringify({ action: 'workers.runtime.error', errorCode: 'redis-unreachable' })}\n`,
      ),
  })
  const connection = getBullMQConnection()
  const queue = new Queue(AGENT_ROUTINE_MAINTENANCE_QUEUE, { connection })
  let worker: Worker | null = null

  const shutdown = createShutdownCoordinator({
    onStart: () => logger.info({ action: 'workers.shutdown', mode: 'agent-routines-only' }),
    phases: [
      {
        name: 'workers',
        resources: [
          {
            name: AGENT_ROUTINE_MAINTENANCE_QUEUE,
            close: () => worker?.close() ?? Promise.resolve(),
          },
        ],
      },
      {
        name: 'scheduler-queues',
        resources: [{ name: AGENT_ROUTINE_MAINTENANCE_QUEUE, close: () => queue.close() }],
      },
      {
        name: 'connection',
        resources: [{ name: 'bullmq', close: closeBullMQConnection }],
      },
      {
        name: 'provider-disabled-connectivity',
        resources: [{ name: 'redis', close: connectivity.shutdown }],
      },
    ],
  })

  await runStartupWithCleanup(async () => {
    // Verify the durable state store before registering a scheduler. The
    // routine processor is otherwise useless and should never look healthy.
    await db.$queryRaw`SELECT 1`
    await applySchedulerState(true, [
      {
        upsert: () =>
          queue.upsertJobScheduler(
            AGENT_ROUTINE_DISPATCH_SCHEDULER_JOB,
            { every: 60_000 },
            {
              name: AGENT_ROUTINE_DISPATCH_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 100,
                removeOnFail: 500,
              },
            },
          ),
        remove: () => queue.removeJobScheduler(AGENT_ROUTINE_DISPATCH_SCHEDULER_JOB),
      },
    ])
    worker = new Worker(
      AGENT_ROUTINE_MAINTENANCE_QUEUE,
      queueSafeJobProcessor(handleAgentRoutineMaintenanceJob),
      { connection, concurrency: 1 },
    )
    worker.on('error', (error) =>
      logger.error({ action: 'workers.runtime.error', error: error.message }),
    )
  }, shutdown)

  const stopOperationalHeartbeat = await startIsolatedRuntimeReadinessHeartbeat({
    schedulersEnabled: true,
  })
  logger.info({
    action: 'workers.started',
    mode: 'agent-routines-only',
    outboundProviderWorkersEnabled: false,
    agentRoutinesEnabled: true,
    queues: [AGENT_ROUTINE_MAINTENANCE_QUEUE],
  })
  return {
    mode: 'agent-routines-only' as const,
    queues: [AGENT_ROUTINE_MAINTENANCE_QUEUE] as const,
    shutdown: async () => {
      await stopOperationalHeartbeat()
      await shutdown()
    },
  }
}
