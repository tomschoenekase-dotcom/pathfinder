import { Resend } from 'resend'

import { env, logger } from '@pathfinder/config'
import { updateJobRecord, writeJobRecord } from '@pathfinder/db'
import type { SendWelcomeEmailJobPayload } from '@pathfinder/jobs'

type ResendClient = Pick<Resend, 'emails'>

let resendClient: ResendClient | null = null

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
  <h1 style="font-size:24px;font-weight:600;margin-bottom:8px;">Welcome to PathFinder</h1>
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
    You're receiving this because you just created a PathFinder account.
  </p>
</body>
</html>`.trim()
}

export async function processSendWelcomeEmailJob(
  payload: SendWelcomeEmailJobPayload,
  bullJobId?: string | null,
): Promise<void> {
  const startedAt = new Date()
  const jobRecordId = await writeJobRecord({
    queue: 'send-email',
    jobName: 'send-welcome-email',
    bullJobId: bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
  })

  try {
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

    await resend.emails.send({
      from: `PathFinder <${fromEmail}>`,
      to: payload.to,
      subject: 'Welcome to PathFinder',
      html: buildEmailHtml(payload.recipientName, payload.orgName, dashboardUrl),
    })

    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.send-welcome-email.sent',
      tenantId: payload.tenantId,
    })
  } catch (error) {
    await updateJobRecord(jobRecordId, {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    throw error
  }
}

export function _setResendClientForTesting(client: ResendClient | null): void {
  resendClient = client
}
