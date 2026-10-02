import { createHash } from 'node:crypto'

import { Resend } from 'resend'

import { env, logger } from '@pathfinder/config'
import {
  beginClientNotificationEmailDelivery,
  completeClientNotificationEmailDelivery,
  failQueuedClientNotificationEmail,
  supportRequestPortalPath,
  updateJobRecord,
  writeJobRecord,
  type ClientNotificationContent,
  type ClientNotificationItem,
} from '@pathfinder/db'
import {
  SEND_CLIENT_NOTIFICATION_EMAIL_JOB,
  SEND_EMAIL_QUEUE,
  type SendClientNotificationEmailJobPayload,
} from '@pathfinder/jobs'

import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  toQueueSafeJobError,
  type JobExecutionInput,
} from '../lib/job-execution'

/**
 * Sends one approved information request by email, through the same Resend provider path the
 * welcome email uses. The job carries identity only. Everything it sends comes from the frozen
 * intent, and it is re-checked against canonical state first: an answered, declined, expired or
 * superseded question is not asked again, and an unknown outcome is never sent a second time.
 */

type ResendClient = Pick<Resend, 'emails'>

let resendClient: ResendClient | null = null
const DELIVERY_DOMAIN = 'pathfinder-client-notification-email-v1'

function getResendClient(): ResendClient | null {
  if (!env.RESEND_API_KEY) return null
  if (!resendClient) resendClient = new Resend(env.RESEND_API_KEY)
  return resendClient
}

function providerIdempotencyKey(payload: SendClientNotificationEmailJobPayload): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([DELIVERY_DOMAIN, payload.tenantId, payload.intentId, payload.generation]),
    )
    .digest('hex')
  return `client-notification-${digest}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function portalLink(origin: string, venueId: string, requestId: string): string {
  return `${origin.replace(/\/+$/u, '')}${supportRequestPortalPath(venueId, requestId)}`
}

/** The exact subject, text and HTML for one email. Every open question and its canonical link. */
export function renderClientNotificationEmail(input: {
  content: ClientNotificationContent
  openItems: readonly ClientNotificationItem[]
  venueId: string
  portalOrigin: string
}): { subject: string; text: string; html: string } {
  const { content, openItems, venueId, portalOrigin } = input
  const links = openItems.map((item) => portalLink(portalOrigin, venueId, item.requestId))
  const heading =
    openItems.length === 1
      ? 'We need one answer from you.'
      : `We need ${openItems.length} answers from you.`

  const text = [
    content.intro,
    '',
    heading,
    ...openItems.flatMap((item, index) => [
      '',
      `${index + 1}. ${item.text}`,
      ...(item.why ? [`   Why we are asking: ${item.why}`] : []),
      ...(item.effect ? [`   What your answer changes: ${item.effect}`] : []),
      `   Answer here: ${links[index]}`,
    ]),
    '',
    'You can also open Help in your Torchiko dashboard and find this conversation there.',
  ].join('\n')

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#1a1a2e;">
  <h1 style="font-size:20px;font-weight:600;margin-bottom:8px;">${escapeHtml(content.subject)}</h1>
  <p style="margin:0 0 16px;white-space:pre-line;">${escapeHtml(content.intro)}</p>
  <p style="margin:0 0 8px;"><strong>${escapeHtml(heading)}</strong></p>
  <ol style="padding-left:20px;margin:0 0 16px;">
${openItems
  .map(
    (item, index) => `    <li style="margin-bottom:12px;">
      ${escapeHtml(item.text)}
${item.why ? `      <br><span style="color:#6b7280;font-size:13px;">Why we are asking: ${escapeHtml(item.why)}</span>\n` : ''}${item.effect ? `      <br><span style="color:#6b7280;font-size:13px;">What your answer changes: ${escapeHtml(item.effect)}</span>\n` : ''}      <br><a href="${escapeHtml(links[index]!)}">Answer in your dashboard</a>
    </li>`,
  )
  .join('\n')}
  </ol>
  <p style="margin:24px 0 0;font-size:12px;color:#6b7280;">
    You are receiving this because someone at Torchiko asked you for information in your dashboard.
  </p>
</body>
</html>`.trim()

  return { subject: content.subject, text, html }
}

export async function processSendClientNotificationEmailJob(
  payload: SendClientNotificationEmailJobPayload,
  executionInput?: JobExecutionInput,
): Promise<void> {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const jobRecordId = await writeJobRecord({
    queue: SEND_EMAIL_QUEUE,
    jobName: SEND_CLIENT_NOTIFICATION_EMAIL_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt: new Date(),
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })
  const identity = {
    tenantId: payload.tenantId,
    intentId: payload.intentId,
    generation: payload.generation,
  }

  try {
    // Nothing is claimed, and nothing leaves, unless the switch, the provider and the portal
    // origin are all in place. A queued email that cannot go out is closed as not sent.
    const resend = env.CLIENT_NOTIFICATION_EMAIL_ENABLED ? getResendClient() : null
    const notReady = !env.CLIENT_NOTIFICATION_EMAIL_ENABLED
      ? 'EMAIL_DELIVERY_DISABLED'
      : !resend || !env.RESEND_FROM_EMAIL
        ? 'EMAIL_PROVIDER_NOT_CONFIGURED'
        : !env.DASHBOARD_URL
          ? 'PORTAL_URL_NOT_CONFIGURED'
          : null
    if (notReady || !resend) {
      await failQueuedClientNotificationEmail({ ...identity, errorCode: notReady! })
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      logger.warn({
        action: 'workers.send-client-notification-email.not-sent',
        reason: notReady,
        tenantId: payload.tenantId,
        intentId: payload.intentId,
      })
      return
    }

    const decision = await beginClientNotificationEmailDelivery(identity)
    if (decision.action === 'skip') {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      logger.info({
        action: 'workers.send-client-notification-email.skipped',
        reason: decision.reason,
        tenantId: payload.tenantId,
        intentId: payload.intentId,
      })
      return
    }

    // From here the provider may have been reached. Every outcome is recorded and none rethrown,
    // because a queue retry could otherwise send the same email twice.
    const message = renderClientNotificationEmail({
      content: decision.content,
      openItems: decision.openItems,
      venueId: decision.venueId,
      portalOrigin: env.DASHBOARD_URL!,
    })
    let outcome: Parameters<typeof completeClientNotificationEmailDelivery>[0]['outcome']
    try {
      const response = await resend.emails.send(
        {
          from: `Torchiko <${env.RESEND_FROM_EMAIL}>`,
          to: decision.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        },
        { idempotencyKey: providerIdempotencyKey(payload) },
      )
      outcome = response.error
        ? { kind: 'failed', errorCode: 'PROVIDER_REJECTED' }
        : { kind: 'sent', providerMessageId: response.data?.id ?? null }
    } catch {
      outcome = { kind: 'unknown', errorCode: 'PROVIDER_CALL_INTERRUPTED' }
    }
    await completeClientNotificationEmailDelivery({ ...identity, outcome })
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
    logger.info({
      action: `workers.send-client-notification-email.${outcome.kind}`,
      tenantId: payload.tenantId,
      intentId: payload.intentId,
    })
  } catch (error) {
    await recordJobFailure({ jobRecordId, error, execution })
    throw toQueueSafeJobError(error, 'CLIENT_NOTIFICATION_EMAIL_FAILED')
  }
}

export function _setClientNotificationResendClientForTesting(client: ResendClient | null): void {
  resendClient = client
}
