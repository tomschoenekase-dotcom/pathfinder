import { Queue, Worker, type Job } from 'bullmq'

import { env } from '@pathfinder/config'
import {
  checkBullMQConnection,
  closeBullMQConnection,
  closeJobQueues,
  GMAIL_SYNC_FULL_RECONCILIATION_JOB,
  GMAIL_SYNC_NOTIFICATION_JOB,
  GMAIL_SYNC_QUEUE,
  GMAIL_SYNC_RECONCILIATION_JOB,
  GMAIL_SYNC_WATCH_RENEWAL_JOB,
  getBullMQConnection,
  type GmailSyncJobPayload,
} from '@pathfinder/jobs'

import { queueSafeJobProcessor } from './lib/job-execution'
import { processGmailSyncJob } from './processors/gmail-sync'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function exactAccountId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 191 &&
    value !== '*' &&
    value.trim() === value &&
    !value.split('').some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
}

export async function processGmailCorrespondenceOnlyJob(
  job: Pick<Job<GmailSyncJobPayload>, 'name' | 'data'>,
) {
  const payload = job.data
  if (!payload || !exactAccountId(payload.providerAccountId)) {
    throw new Error('Gmail correspondence jobs require one exact provider account')
  }
  const expectedName =
    payload.trigger === 'FULL_RECONCILIATION'
      ? GMAIL_SYNC_FULL_RECONCILIATION_JOB
      : payload.trigger === 'SCHEDULED_RECONCILIATION'
        ? GMAIL_SYNC_RECONCILIATION_JOB
        : payload.trigger === 'PUBSUB_NOTIFICATION'
          ? GMAIL_SYNC_NOTIFICATION_JOB
          : payload.trigger === 'WATCH_RENEWAL'
            ? GMAIL_SYNC_WATCH_RENEWAL_JOB
            : null
  if (!expectedName || job.name !== expectedName) {
    throw new Error('Unsupported Gmail correspondence job')
  }
  if (payload.trigger === 'FULL_RECONCILIATION' && !UUID_PATTERN.test(payload.requestId)) {
    throw new Error('Full Gmail reconciliation requires a stable request identity')
  }
  // Watch mutation is deliberately excluded from this read/reconciliation-only runtime.
  if (payload.trigger === 'WATCH_RENEWAL') return { skipped: 'watch-renewal-disabled' as const }
  return processGmailSyncJob(payload)
}

export async function startGmailCorrespondenceOnlyRuntime() {
  if (!env.GMAIL_CORRESPONDENCE_WORKERS_ENABLED || env.OUTBOUND_PROVIDER_WORKERS_ENABLED) {
    throw new Error(
      'Gmail correspondence-only runtime requires explicit enablement with outbound providers disabled',
    )
  }
  await checkBullMQConnection(5_000)
  const connection = getBullMQConnection()
  const gmailSyncQueue = new Queue(GMAIL_SYNC_QUEUE, { connection })
  const gmailSyncWorker = new Worker(
    GMAIL_SYNC_QUEUE,
    queueSafeJobProcessor(processGmailCorrespondenceOnlyJob),
    { connection, concurrency: 1 },
  )
  gmailSyncWorker.on('error', () => {
    process.stderr.write(
      `${JSON.stringify({
        action: 'workers.runtime.error',
        queueName: GMAIL_SYNC_QUEUE,
        errorCode: 'gmail-correspondence-worker-error',
      })}\n`,
    )
  })
  process.stdout.write(
    `${JSON.stringify({
      action: 'workers.started',
      mode: 'gmail-correspondence-only',
      outboundProviderWorkersEnabled: false,
      queues: [GMAIL_SYNC_QUEUE],
    })}\n`,
  )
  const shutdown = async () => {
    await gmailSyncWorker.close()
    await gmailSyncQueue.close()
    await closeJobQueues()
    await closeBullMQConnection()
  }
  return { mode: 'gmail-correspondence-only' as const, queues: [GMAIL_SYNC_QUEUE], shutdown }
}
