import { Queue, Worker, type Job } from 'bullmq'

import {
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

export async function startCrmBackgroundRuntime() {
  await checkBullMQConnection(5_000)
  const connection = getBullMQConnection()
  const queue = new Queue(PROSPECT_IMPORT_QUEUE, { connection })
  const worker = new Worker(PROSPECT_IMPORT_QUEUE, handleImport, {
    connection,
    concurrency: 1,
  })
  worker.on('error', (error) => {
    process.stderr.write(
      `${JSON.stringify({
        action: 'workers.runtime.error',
        queueName: PROSPECT_IMPORT_QUEUE,
        errorCode: 'crm-background-worker-error',
        detail: error.message,
      })}\n`,
    )
  })
  const shutdown = async () => {
    await worker.close()
    await queue.close()
    await closeJobQueues()
    await closeBullMQConnection()
  }
  process.stdout.write(
    `${JSON.stringify({
      action: 'workers.started',
      mode: 'crm-only',
      outboundProviderWorkersEnabled: false,
      queues: [PROSPECT_IMPORT_QUEUE],
    })}\n`,
  )
  return {
    mode: 'crm-only' as const,
    queues: [PROSPECT_IMPORT_QUEUE] as const,
    prospectImportQueue: queue,
    prospectImportWorker: worker,
    shutdown,
  }
}
