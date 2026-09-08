import { Queue, Worker, type Job } from 'bullmq'

import { isFeatureEnabled } from '@pathfinder/config'
import {
  checkBullMQConnection,
  closeBullMQConnection,
  closeJobQueues,
  getBullMQConnection,
  INTAKE_V1_FILE_EXTRACTION_PROCESS_JOB,
  INTAKE_V1_FILE_EXTRACTION_QUEUE,
  INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB,
  type IntakeV1FileExtractionJobPayload,
} from '@pathfinder/jobs'

import { queueSafeJobProcessor } from './lib/job-execution'
import { startIsolatedRuntimeReadinessHeartbeat } from './lib/isolated-runtime-readiness'
import {
  processIntakeV1FileExtractionJob,
  reconcileIntakeV1FileExtractionJobs,
} from './processors/intake-v1-file-extraction'

export async function handleIntakeV1FileExtraction(
  job: Job<IntakeV1FileExtractionJobPayload | Record<string, never>>,
) {
  if (
    job.name !== INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB &&
    job.name !== INTAKE_V1_FILE_EXTRACTION_PROCESS_JOB
  ) {
    throw new Error(`Unsupported intake V1 file extraction job: ${job.name}`)
  }
  if (!isFeatureEnabled('intakeV1FileExtractionWorker')) {
    return job.name === INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB ? { discovered: 0 } : 'disabled'
  }
  if (job.name === INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB) {
    return reconcileIntakeV1FileExtractionJobs()
  }
  return processIntakeV1FileExtractionJob(
    job.data as IntakeV1FileExtractionJobPayload,
    `intake-v1-file:${process.pid}:${String(job.id ?? job.name)}`,
  )
}

export async function createIntakeV1FileExtractionResources() {
  if (!isFeatureEnabled('intakeV1FileExtractionWorker')) {
    throw new Error('Intake V1 file extraction worker is disabled.')
  }
  const connection = getBullMQConnection()
  const queue = new Queue(INTAKE_V1_FILE_EXTRACTION_QUEUE, { connection })
  await queue.upsertJobScheduler(
    INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB,
    { every: 60_000 },
    {
      name: INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB,
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
    INTAKE_V1_FILE_EXTRACTION_QUEUE,
    queueSafeJobProcessor(handleIntakeV1FileExtraction),
    { connection, concurrency: 1, lockDuration: 120_000 },
  )
  worker.on('error', () => {
    process.stderr.write(
      `${JSON.stringify({
        action: 'workers.runtime.error',
        queueName: worker.name,
        errorCode: 'intake-v1-file-extraction-worker-error',
      })}\n`,
    )
  })
  const close = async () => {
    await worker.close()
    await queue.close()
  }
  return { queue, worker, close }
}

export async function startIntakeV1FileExtractionRuntime() {
  if (!isFeatureEnabled('intakeV1FileExtractionWorker')) {
    throw new Error('Intake V1 file extraction worker is disabled.')
  }
  await checkBullMQConnection(5_000)
  const resources = await createIntakeV1FileExtractionResources()
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
      mode: 'intake-v1-file-extraction-only',
      outboundProviderWorkersEnabled: false,
      queues: [INTAKE_V1_FILE_EXTRACTION_QUEUE],
    })}\n`,
  )
  return {
    mode: 'intake-v1-file-extraction-only' as const,
    queues: [INTAKE_V1_FILE_EXTRACTION_QUEUE] as const,
    queue: resources.queue,
    worker: resources.worker,
    shutdown,
  }
}
