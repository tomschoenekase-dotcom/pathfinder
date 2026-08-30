import { Queue, Worker, type Job } from 'bullmq'

import {
  checkBullMQConnection,
  closeBullMQConnection,
  closeJobQueues,
  getBullMQConnection,
  INTAKE_UPLOAD_VERIFICATION_PROCESS_JOB,
  INTAKE_UPLOAD_VERIFICATION_QUEUE,
  INTAKE_UPLOAD_VERIFICATION_RECONCILIATION_JOB,
  type IntakeUploadVerificationJobPayload,
} from '@pathfinder/jobs'

import {
  processIntakeUploadVerificationJob,
  reconcileIntakeUploadVerificationJobs,
} from './processors/intake-upload-verification'

async function handleVerification(
  job: Job<IntakeUploadVerificationJobPayload | Record<string, never>>,
) {
  if (job.name === INTAKE_UPLOAD_VERIFICATION_RECONCILIATION_JOB)
    return reconcileIntakeUploadVerificationJobs()
  if (job.name !== INTAKE_UPLOAD_VERIFICATION_PROCESS_JOB)
    throw new Error(`Unsupported intake upload verification job: ${job.name}`)
  return processIntakeUploadVerificationJob(
    job.data as IntakeUploadVerificationJobPayload,
    String(job.id ?? job.name),
  )
}

export async function createIntakeUploadVerificationResources() {
  const connection = getBullMQConnection()
  const queue = new Queue(INTAKE_UPLOAD_VERIFICATION_QUEUE, { connection })
  await queue.upsertJobScheduler(
    INTAKE_UPLOAD_VERIFICATION_RECONCILIATION_JOB,
    { every: 60_000 },
    {
      name: INTAKE_UPLOAD_VERIFICATION_RECONCILIATION_JOB,
      data: {},
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 20,
        removeOnFail: 100,
      },
    },
  )
  const worker = new Worker(INTAKE_UPLOAD_VERIFICATION_QUEUE, handleVerification, {
    connection,
    concurrency: 2,
  })
  worker.on('error', () => {
    process.stderr.write(
      `${JSON.stringify({
        action: 'workers.runtime.error',
        queueName: worker.name,
        errorCode: 'intake-upload-verification-worker-error',
      })}\n`,
    )
  })
  const close = async () => {
    await worker.close()
    await queue.close()
  }
  return { queue, worker, close }
}

export type IntakeUploadVerificationResources = Awaited<
  ReturnType<typeof createIntakeUploadVerificationResources>
>

export async function startIntakeUploadVerificationRuntime() {
  await checkBullMQConnection(5_000)
  const resources = await createIntakeUploadVerificationResources()
  const shutdown = async () => {
    await resources.close()
    await closeJobQueues()
    await closeBullMQConnection()
  }
  process.stdout.write(
    `${JSON.stringify({
      action: 'workers.started',
      mode: 'intake-upload-verification-only',
      outboundProviderWorkersEnabled: false,
      queues: [INTAKE_UPLOAD_VERIFICATION_QUEUE],
    })}\n`,
  )
  return {
    mode: 'intake-upload-verification-only' as const,
    queues: [INTAKE_UPLOAD_VERIFICATION_QUEUE] as const,
    queue: resources.queue,
    worker: resources.worker,
    shutdown,
  }
}
