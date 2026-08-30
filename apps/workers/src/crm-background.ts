import { Queue, Worker, type Job } from 'bullmq'

import { env } from '@pathfinder/config'
import {
  ACCOUNT_SUMMARY_REFRESH_QUEUE,
  ACCOUNT_SUMMARY_REFRESH_SCHEDULER_JOB,
  checkBullMQConnection,
  closeBullMQConnection,
  closeJobQueues,
  getBullMQConnection,
  PROSPECT_IMPORT_COMMIT_JOB,
  PROSPECT_IMPORT_INSPECT_JOB,
  PROSPECT_IMPORT_QUEUE,
  PROSPECT_IMPORT_STAGE_JOB,
  type ProspectImportCommitJobPayload,
  type ProspectImportInspectionJobPayload,
  type ProspectImportStagingJobPayload,
} from '@pathfinder/jobs'

import { processStaleAccountSummaries } from './processors/account-summary-refresh'
import { createIntakeUploadVerificationResources } from './intake-upload-verification-runtime'
import {
  processProspectImportInspectionJob,
  processProspectImportCommitJob,
  processProspectImportStagingJob,
} from './processors/prospect-import'

type ProspectImportJobPayload =
  | ProspectImportCommitJobPayload
  | ProspectImportInspectionJobPayload
  | ProspectImportStagingJobPayload

async function handleImport(job: Job<ProspectImportJobPayload>) {
  if (job.name === PROSPECT_IMPORT_INSPECT_JOB)
    return processProspectImportInspectionJob(job.data.importId)
  if (job.name === PROSPECT_IMPORT_STAGE_JOB)
    return processProspectImportStagingJob(job.data.importId)
  if (job.name === PROSPECT_IMPORT_COMMIT_JOB) return processProspectImportCommitJob(job.data)
  throw new Error(`Unsupported CRM background job: ${job.name}`)
}

async function handleAccountSummaryRefresh(job: Job<Record<string, never>>) {
  if (job.name !== ACCOUNT_SUMMARY_REFRESH_SCHEDULER_JOB) {
    throw new Error(`Unsupported CRM account summary job: ${job.name}`)
  }
  return processStaleAccountSummaries({ systemJobId: String(job.id ?? job.name) })
}

export async function startCrmBackgroundRuntime() {
  await checkBullMQConnection(5_000)
  const connection = getBullMQConnection()
  const prospectImportQueue = new Queue(PROSPECT_IMPORT_QUEUE, { connection })
  const accountSummaryQueue = new Queue(ACCOUNT_SUMMARY_REFRESH_QUEUE, { connection })
  await accountSummaryQueue.upsertJobScheduler(
    ACCOUNT_SUMMARY_REFRESH_SCHEDULER_JOB,
    { every: 5 * 60_000 },
    {
      name: ACCOUNT_SUMMARY_REFRESH_SCHEDULER_JOB,
      data: {},
      opts: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 20,
        removeOnFail: 100,
      },
    },
  )
  const prospectImportWorker = new Worker(PROSPECT_IMPORT_QUEUE, handleImport, {
    connection,
    concurrency: 1,
  })
  const accountSummaryWorker = new Worker(
    ACCOUNT_SUMMARY_REFRESH_QUEUE,
    handleAccountSummaryRefresh,
    { connection, concurrency: 1 },
  )
  const intakeVerification = env.INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED
    ? await createIntakeUploadVerificationResources()
    : null
  const workers = [
    prospectImportWorker,
    accountSummaryWorker,
    ...(intakeVerification ? [intakeVerification.worker] : []),
  ]
  for (const worker of workers)
    worker.on('error', () => {
      process.stderr.write(
        `${JSON.stringify({
          action: 'workers.runtime.error',
          queueName: worker.name,
          errorCode: 'crm-background-worker-error',
        })}\n`,
      )
    })
  const shutdown = async () => {
    await Promise.all(workers.map((worker) => worker.close()))
    await accountSummaryQueue.close()
    await prospectImportQueue.close()
    if (intakeVerification) await intakeVerification.queue.close()
    await closeJobQueues()
    await closeBullMQConnection()
  }
  process.stdout.write(
    `${JSON.stringify({
      action: 'workers.started',
      mode: 'crm-only',
      outboundProviderWorkersEnabled: false,
      queues: [
        PROSPECT_IMPORT_QUEUE,
        ACCOUNT_SUMMARY_REFRESH_QUEUE,
        ...(intakeVerification ? [intakeVerification.queue.name] : []),
      ],
    })}\n`,
  )
  return {
    mode: 'crm-only' as const,
    queues: [
      PROSPECT_IMPORT_QUEUE,
      ACCOUNT_SUMMARY_REFRESH_QUEUE,
      ...(intakeVerification ? [intakeVerification.queue.name] : []),
    ],
    prospectImportQueue,
    prospectImportWorker,
    accountSummaryQueue,
    accountSummaryWorker,
    intakeVerification,
    shutdown,
  }
}
