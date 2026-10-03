import { Queue, Worker, type Job } from 'bullmq'

import {
  checkBullMQConnection,
  closeBullMQConnection,
  closeJobQueues,
  getBullMQConnection,
  INTAKE_V1_SOURCE_PROCESSING_PROCESS_JOB,
  INTAKE_V1_SOURCE_PROCESSING_QUEUE,
  INTAKE_V1_SOURCE_PROCESSING_RECOVERY_JOB,
  VENUE_SOURCE_CAPTURE_PROCESS_JOB,
  type IntakeV1SourceProcessingJobPayload,
  type VenueSourceCaptureJobPayload,
} from '@pathfinder/jobs'
import { isFeatureEnabled } from '@pathfinder/config'

import { getJobExecutionMetadata, queueSafeJobProcessor } from './lib/job-execution'
import { startIsolatedRuntimeReadinessHeartbeat } from './lib/isolated-runtime-readiness'
import {
  processIntakeV1SourceProcessingJob,
  reconcileIntakeV1SourceProcessingJobs,
} from './processors/intake-v1-source-processing'
import { processVenueSourceCaptureJob } from './processors/venue-source-capture'

export async function handleIntakeV1WebsiteResearch(
  job: Job<
    IntakeV1SourceProcessingJobPayload | VenueSourceCaptureJobPayload | Record<string, never>
  >,
) {
  if (job.name === VENUE_SOURCE_CAPTURE_PROCESS_JOB) {
    // Operator-requested venue source capture shares this isolated runtime and its flag. The job
    // carries only opaque scope IDs; the processor re-reads the source and the authorized hosts.
    if (!isFeatureEnabled('intakeV1WebsiteResearchWorker')) return 'disabled'
    return processVenueSourceCaptureJob(
      job.data as VenueSourceCaptureJobPayload,
      getJobExecutionMetadata(job),
    )
  }
  if (
    job.name !== INTAKE_V1_SOURCE_PROCESSING_RECOVERY_JOB &&
    job.name !== INTAKE_V1_SOURCE_PROCESSING_PROCESS_JOB
  ) {
    throw new Error(`Unsupported intake V1 source processing job: ${job.name}`)
  }
  if (!isFeatureEnabled('intakeV1WebsiteResearchWorker')) {
    return job.name === INTAKE_V1_SOURCE_PROCESSING_RECOVERY_JOB ? { discovered: 0 } : 'disabled'
  }
  if (job.name === INTAKE_V1_SOURCE_PROCESSING_RECOVERY_JOB) {
    return reconcileIntakeV1SourceProcessingJobs()
  }
  return processIntakeV1SourceProcessingJob(
    job.data as IntakeV1SourceProcessingJobPayload,
    `intake-v1-research:${process.pid}:${String(job.id ?? job.name)}`,
    undefined,
  )
}

export async function createIntakeV1WebsiteResearchResources() {
  if (!isFeatureEnabled('intakeV1WebsiteResearchWorker')) {
    throw new Error('Intake V1 website research worker is disabled.')
  }
  const connection = getBullMQConnection()
  const queue = new Queue(INTAKE_V1_SOURCE_PROCESSING_QUEUE, { connection })
  await queue.upsertJobScheduler(
    INTAKE_V1_SOURCE_PROCESSING_RECOVERY_JOB,
    { every: 60_000 },
    {
      name: INTAKE_V1_SOURCE_PROCESSING_RECOVERY_JOB,
      data: {},
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 20,
        removeOnFail: 100,
      },
    },
  )
  const worker = new Worker(
    INTAKE_V1_SOURCE_PROCESSING_QUEUE,
    queueSafeJobProcessor(handleIntakeV1WebsiteResearch),
    { connection, concurrency: 1 },
  )
  worker.on('error', () => {
    process.stderr.write(
      `${JSON.stringify({
        action: 'workers.runtime.error',
        queueName: worker.name,
        errorCode: 'intake-v1-website-research-worker-error',
      })}\n`,
    )
  })
  const close = async () => {
    await worker.close()
    await queue.close()
  }
  return { queue, worker, close }
}

export async function startIntakeV1WebsiteResearchRuntime() {
  if (!isFeatureEnabled('intakeV1WebsiteResearchWorker')) {
    throw new Error('Intake V1 website research worker is disabled.')
  }
  await checkBullMQConnection(5_000)
  const resources = await createIntakeV1WebsiteResearchResources()
  const stopOperationalHeartbeat = await startIsolatedRuntimeReadinessHeartbeat({
    schedulersEnabled: true,
  })
  const shutdown = async () => {
    await stopOperationalHeartbeat()
    await resources.close()
    await closeJobQueues()
    await closeBullMQConnection()
  }
  process.stdout.write(
    `${JSON.stringify({
      action: 'workers.started',
      mode: 'intake-v1-website-research-only',
      outboundProviderWorkersEnabled: false,
      queues: [INTAKE_V1_SOURCE_PROCESSING_QUEUE],
    })}\n`,
  )
  return {
    mode: 'intake-v1-website-research-only' as const,
    queues: [INTAKE_V1_SOURCE_PROCESSING_QUEUE] as const,
    queue: resources.queue,
    worker: resources.worker,
    shutdown,
  }
}
