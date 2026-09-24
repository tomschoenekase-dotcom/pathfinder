import type { Job } from 'bullmq'
import {
  SEND_PROSPECT_OUTREACH_JOB,
  SEND_WELCOME_EMAIL_JOB,
  type SendProspectOutreachJobPayload,
  type SendWelcomeEmailJobPayload,
} from '@pathfinder/jobs'
import { verifyStoredNativeOrigin } from '@pathfinder/db'
import { getJobExecutionMetadata } from '../lib/job-execution'
import { processSendWelcomeEmailJob } from './send-welcome-email'
import { processSendProspectOutreachJob } from './send-prospect-outreach'

/** The normal send-email registration and isolated BullMQ rehearsal share one
 * handler. Native-origin jobs always get the DB-owned current-source verifier. */
export async function handleSendEmailQueueJob(
  job: Job<SendWelcomeEmailJobPayload | SendProspectOutreachJobPayload>,
) {
  if (job.name === SEND_WELCOME_EMAIL_JOB) {
    await processSendWelcomeEmailJob(
      job.data as SendWelcomeEmailJobPayload,
      getJobExecutionMetadata(job),
    )
    return
  }
  if (job.name === SEND_PROSPECT_OUTREACH_JOB) {
    await processSendProspectOutreachJob(job.data as SendProspectOutreachJobPayload, {
      verifyNativeOrigin: verifyStoredNativeOrigin,
    })
    return
  }
  throw new Error(`Unsupported send-email job: ${job.name}`)
}
