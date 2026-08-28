import { Worker, type Job } from 'bullmq'

import {
  closeBullMQConnection,
  getBullMQConnection,
  VENUE_MEDIA_DERIVATIVE_PROCESS_JOB,
  VENUE_MEDIA_DERIVATIVE_QUEUE,
  VENUE_MEDIA_DERIVATIVE_RETRY_BACKOFF,
  type VenueMediaDerivativeJobPayload,
} from '@pathfinder/jobs'

import { checkProviderDisabledRedis } from './lib/provider-disabled-redis'
import { startProviderDisabledRuntime } from './lib/provider-disabled-runtime'
import { processVenueMediaDerivativeJob } from './processors/venue-media-derivative'
import { startFounderAbsenceObserver } from './founder-absence-observer-runtime'

async function handleVenueMediaDerivativeJob(job: Job<VenueMediaDerivativeJobPayload>) {
  if (job.name !== VENUE_MEDIA_DERIVATIVE_PROCESS_JOB) {
    throw new Error(`Unsupported venue media derivative job: ${job.name}`)
  }
  await processVenueMediaDerivativeJob(job.data)
}

export async function startVenueMediaDerivativeRuntime() {
  const redisUrl = process.env.REDIS_URL!
  const connectivity = await startProviderDisabledRuntime({
    checkConnection: () => checkProviderDisabledRedis(redisUrl, 5_000),
    closeConnection: async () => undefined,
    onConnectionError: () =>
      process.stderr.write(
        `${JSON.stringify({ action: 'workers.runtime.error', errorCode: 'redis-unreachable' })}\n`,
      ),
  })
  const worker = new Worker(VENUE_MEDIA_DERIVATIVE_QUEUE, handleVenueMediaDerivativeJob, {
    connection: getBullMQConnection(),
    concurrency: 2,
    settings: {
      backoffStrategy: (attemptsMade, type) =>
        type === VENUE_MEDIA_DERIVATIVE_RETRY_BACKOFF
          ? Math.min(attemptsMade * 30_000, 2 * 60_000)
          : 0,
    },
  })
  worker.on('error', () =>
    process.stderr.write(
      `${JSON.stringify({ action: 'workers.runtime.error', errorCode: 'venue-media-derivative-worker-error' })}\n`,
    ),
  )
  const founderAbsenceObserver =
    process.env.FOUNDER_ABSENCE_OBSERVER_ENABLED === 'true'
      ? await startFounderAbsenceObserver()
      : null
  const shutdown = async () => {
    await founderAbsenceObserver?.shutdown()
    await worker.close()
    await connectivity.shutdown()
    await closeBullMQConnection()
  }
  return {
    mode: 'venue-media-derivative-only' as const,
    queues: [VENUE_MEDIA_DERIVATIVE_QUEUE] as const,
    worker,
    founderAbsenceObserverEnabled: founderAbsenceObserver !== null,
    shutdown,
  }
}
