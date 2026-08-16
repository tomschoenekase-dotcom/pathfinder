import { createHash } from 'node:crypto'

import { Resend } from 'resend'

import { env, logger } from '@pathfinder/config'
import {
  beginWelcomeEmailDeliveryAttempt,
  getWelcomeEmailDeliveryState,
  markWelcomeEmailDeliveryComplete,
  updateJobRecord,
  writeJobRecord,
} from '@pathfinder/db'
import {
  SEND_EMAIL_QUEUE,
  SEND_WELCOME_EMAIL_JOB,
  type SendWelcomeEmailJobPayload,
} from '@pathfinder/jobs'

import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  type JobExecutionInput,
} from '../lib/job-execution'

type ResendClient = Pick<Resend, 'emails'>

let resendClient: ResendClient | null = null
const WELCOME_EMAIL_DELIVERY_DOMAIN = 'pathfinder-welcome-email-v1'
const WELCOME_EMAIL_AUTOMATIC_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000

function validateDeliveryId(deliveryId: string): void {
  if (typeof deliveryId !== 'string' || deliveryId.trim().length === 0 || deliveryId.length > 200) {
    throw new Error(
      'Welcome email delivery ID must be a nonempty opaque identifier of at most 200 characters',
    )
  }
}

function providerIdempotencyKey(payload: SendWelcomeEmailJobPayload): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([WELCOME_EMAIL_DELIVERY_DOMAIN, payload.tenantId, payload.deliveryId]))
    .digest('hex')
  return `welcome-email-${digest}`
}

function getResendClient(): ResendClient | null {
  if (!env.RESEND_API_KEY) return null
  if (!resendClient) resendClient = new Resend(env.RESEND_API_KEY)
  return resendClient
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildEmailHtml(
  recipientName: string | null,
  orgName: string,
  dashboardUrl: string,
): string {
  const greeting = recipientName ? `Hi ${escapeHtml(recipientName)},` : 'Hi there,'
  const escapedOrgName = escapeHtml(orgName)
  const escapedDashboardUrl = escapeHtml(dashboardUrl)

  return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#1a1a2e;">
  <h1 style="font-size:24px;font-weight:600;margin-bottom:8px;">Welcome to Torchico</h1>
  <p style="margin:0 0 16px;">${greeting}</p>
  <p style="margin:0 0 16px;">
    <strong>${escapedOrgName}</strong> is set up and ready. Head to your dashboard to create your first
    venue and start building your AI guide.
  </p>
  <a href="${escapedDashboardUrl}"
     style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;
            padding:12px 24px;border-radius:9999px;font-size:14px;font-weight:500;">
    Open dashboard →
  </a>
  <p style="margin:32px 0 0;font-size:12px;color:#6b7280;">
    You're receiving this because you just created a Torchico account.
  </p>
</body>
</html>`.trim()
}

export async function processSendWelcomeEmailJob(
  payload: SendWelcomeEmailJobPayload,
  executionInput?: JobExecutionInput,
): Promise<void> {
  validateDeliveryId(payload.deliveryId)

  const execution = normalizeJobExecutionMetadata(executionInput)
  const startedAt = new Date()
  const jobRecordId = await writeJobRecord({
    queue: SEND_EMAIL_QUEUE,
    jobName: SEND_WELCOME_EMAIL_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })

  try {
    let deliveryState = await getWelcomeEmailDeliveryState(payload.tenantId, payload.deliveryId)
    if (deliveryState.complete) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      logger.info({
        action: 'workers.send-welcome-email.skipped',
        reason: 'delivery-already-complete-or-membership-inactive',
        tenantId: payload.tenantId,
      })
      return
    }

    const resend = getResendClient()

    if (!resend) {
      logger.warn({
        action: 'workers.send-welcome-email.skipped',
        reason: 'RESEND_API_KEY not configured',
        tenantId: payload.tenantId,
      })
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return
    }

    const fromEmail = env.RESEND_FROM_EMAIL ?? 'noreply@pathfinder.ai'
    const dashboardUrl = env.DASHBOARD_URL ?? 'https://dashboard.pathfinder.ai'

    if (!deliveryState.attemptedAt) {
      deliveryState = await beginWelcomeEmailDeliveryAttempt(payload.tenantId, payload.deliveryId)
    }
    if (deliveryState.complete) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return
    }
    if (!deliveryState.attemptedAt) {
      throw new Error('Welcome email delivery attempt could not be persisted')
    }
    if (
      Date.now() - deliveryState.attemptedAt.getTime() >
      WELCOME_EMAIL_AUTOMATIC_RETRY_WINDOW_MS
    ) {
      throw new Error('Welcome email delivery is ambiguous and requires manual reconciliation')
    }

    const response = await resend.emails.send(
      {
        from: `Torchico <${fromEmail}>`,
        to: payload.to,
        subject: 'Welcome to Torchico',
        html: buildEmailHtml(payload.recipientName, payload.orgName, dashboardUrl),
      },
      { idempotencyKey: providerIdempotencyKey(payload) },
    )
    if (response.error) {
      throw new Error('Welcome email provider rejected the request')
    }

    await markWelcomeEmailDeliveryComplete(payload.tenantId, payload.deliveryId)
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.send-welcome-email.sent',
      tenantId: payload.tenantId,
    })
  } catch (error) {
    await recordJobFailure({
      jobRecordId,
      error,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      execution,
    })
    throw error
  }
}

export function _setResendClientForTesting(client: ResendClient | null): void {
  resendClient = client
}
