import { createHash } from 'node:crypto'

import { Webhook } from 'svix'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

export const runtime = 'nodejs'

type ResendEnvelope = { type: string; created_at: string; data: Record<string, unknown> }

function parseEnvelope(value: unknown): ResendEnvelope {
  if (!value || typeof value !== 'object') throw new Error('Invalid webhook envelope')
  const event = value as Record<string, unknown>
  if (
    typeof event.type !== 'string' ||
    event.type.length > 100 ||
    typeof event.created_at !== 'string' ||
    !Number.isFinite(Date.parse(event.created_at)) ||
    !event.data ||
    typeof event.data !== 'object' ||
    Array.isArray(event.data)
  ) {
    throw new Error('Invalid webhook envelope')
  }
  return {
    type: event.type,
    created_at: event.created_at,
    data: event.data as Record<string, unknown>,
  }
}

function statusForEvent(type: string) {
  return (
    {
      'email.sent': ['SENT', 'SENT'],
      'email.delivered': ['DELIVERED', 'DELIVERED'],
      'email.delivery_delayed': ['DELAYED', 'DELAYED'],
      'email.bounced': ['BOUNCED', 'BOUNCED'],
      'email.complained': ['COMPLAINED', 'COMPLAINED'],
      'email.suppressed': ['SUPPRESSED', 'SUPPRESSED'],
      'email.failed': ['FAILED', 'FAILED'],
    } as const
  )[type]
}

async function processDeliveryEvent(
  eventId: string,
  type: string,
  createdAt: Date,
  data: Record<string, unknown>,
) {
  const emailId = typeof data.email_id === 'string' ? data.email_id : null
  if (!emailId) return
  const statuses = statusForEvent(type)
  if (!statuses) return
  const item = await db.prospectSendItem.findUnique({
    where: { providerMessageId: emailId },
    include: { member: true, message: true },
  })
  if (!item) return
  await db.$transaction(async (tx) => {
    await tx.prospectEmailEvent.upsert({
      where: { providerEventId: eventId },
      create: {
        providerEventId: eventId,
        sendItemId: item.id,
        emailMessageId: item.message?.id ?? null,
        eventType: type,
        payload: data,
        occurredAt: createdAt,
      },
      update: {},
    })
    await tx.prospectSendItem.update({ where: { id: item.id }, data: { status: statuses[0] } })
    if (item.message)
      await tx.prospectEmailMessage.update({
        where: { id: item.message.id },
        data: { status: statuses[1] },
      })
    if (type === 'email.complained' || type === 'email.bounced' || type === 'email.suppressed') {
      if (item.member.contactId) {
        await tx.prospectContact.update({
          where: { id: item.member.contactId },
          data: { doNotContact: true, suppressionReason: type, updatedBy: 'system:resend-webhook' },
        })
      }
      await tx.prospectCampaignMember.update({
        where: { id: item.memberId },
        data: { status: type === 'email.bounced' ? 'BOUNCED' : 'SUPPRESSED' },
      })
    }
  })
}

type ReceivedEmail = {
  id: string
  from: string
  to: string[]
  subject: string
  text: string | null
  html: string | null
  message_id: string | null
  created_at: string
  attachments?: unknown[]
}

async function retrieveReceivedEmail(emailId: string): Promise<ReceivedEmail> {
  const response = await fetch(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
    {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY ?? ''}` },
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!response.ok) throw new Error(`Received email retrieval failed (${response.status})`)
  return response.json() as Promise<ReceivedEmail>
}

async function processInbound(eventId: string, data: Record<string, unknown>) {
  const emailId = typeof data.email_id === 'string' ? data.email_id : null
  if (!emailId || !process.env.RESEND_API_KEY)
    throw new Error('Inbound email provider is not configured')
  const email = await retrieveReceivedEmail(emailId)
  const domain = process.env.PROSPECT_OUTREACH_REPLY_DOMAIN?.toLowerCase()
  const recipient = email.to.find((value) => domain && value.toLowerCase().endsWith(`@${domain}`))
  const token = recipient?.split('@')[0]?.replace(/^reply\+/u, '')
  if (!token || token.length > 200) return
  const thread = await db.prospectEmailThread.findUnique({
    where: { replyTokenHash: createHash('sha256').update(token).digest('hex') },
    include: { organization: { include: { opportunity: true } } },
  })
  if (!thread) return
  const occurredAt = new Date(email.created_at)
  const textBody = email.text?.slice(0, 200_000) ?? null
  const htmlBody = email.html?.slice(0, 500_000) ?? null
  const attachmentMetadata = (email.attachments ?? []).slice(0, 100) as object[]
  await db.$transaction(async (tx) => {
    await tx.prospectEmailMessage.upsert({
      where: { providerMessageId: email.id },
      create: {
        threadId: thread.id,
        organizationId: thread.organizationId,
        venueId: thread.venueId,
        contactId: thread.contactId,
        direction: 'INBOUND',
        status: 'RECEIVED',
        providerMessageId: email.id,
        internetMessageId: email.message_id,
        fromAddress: email.from,
        toAddresses: email.to,
        subject: email.subject,
        textBody,
        htmlBody,
        attachmentMetadata,
        occurredAt,
      },
      update: {},
    })
    await tx.prospectEmailEvent.upsert({
      where: { providerEventId: eventId },
      create: { providerEventId: eventId, eventType: 'email.received', payload: data, occurredAt },
      update: {},
    })
    await tx.prospectEmailThread.update({
      where: { id: thread.id },
      data: { lastMessageAt: occurredAt },
    })
    if (thread.organization.opportunity) {
      const opportunity = thread.organization.opportunity
      if (!['WON', 'LOST', 'DO_NOT_CONTACT'].includes(opportunity.stage)) {
        await tx.prospectOpportunity.update({
          where: { id: opportunity.id },
          data: {
            stage: 'REPLIED',
            nextAction: 'Review and respond',
            nextActionAt: null,
            lastActivityAt: occurredAt,
            updatedBy: 'system:resend-webhook',
          },
        })
        await tx.prospectStageHistory.create({
          data: {
            opportunityId: opportunity.id,
            fromStage: opportunity.stage,
            toStage: 'REPLIED',
            reason: 'Inbound email received',
            actorId: 'system:resend-webhook',
            evidence: { providerMessageId: email.id },
          },
        })
        await tx.prospectFollowup.updateMany({
          where: { organizationId: thread.organizationId, status: 'PENDING' },
          data: { status: 'CANCELLED', cancelledAt: occurredAt, reason: 'Recipient replied' },
        })
      }
    }
    await tx.prospectCampaignMember.updateMany({
      where: { organizationId: thread.organizationId, status: { in: ['SENT', 'QUEUED'] } },
      data: { status: 'REPLIED' },
    })
    await tx.prospectActivity.create({
      data: {
        organizationId: thread.organizationId,
        venueId: thread.venueId,
        contactId: thread.contactId,
        type: 'REPLY_RECEIVED',
        summary: 'Inbound email received',
        evidence: { providerMessageId: email.id, threadId: thread.id },
        actorId: 'system:resend-webhook',
        occurredAt,
      },
    })
  })
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) return Response.json({ error: 'Webhook is not configured' }, { status: 503 })
  const rawBody = await request.text()
  const headers = {
    'svix-id': request.headers.get('svix-id') ?? '',
    'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
    'svix-signature': request.headers.get('svix-signature') ?? '',
  }
  let verified: unknown
  try {
    verified = new Webhook(secret).verify(rawBody, headers)
  } catch {
    return Response.json({ error: 'Invalid signature' }, { status: 400 })
  }
  const event = parseEnvelope(verified)
  const eventId = headers['svix-id']
  try {
    await withTenantIsolationBypass(async () => {
      const receipt = await db.prospectEmailWebhookReceipt.upsert({
        where: { provider_providerEventId: { provider: 'resend', providerEventId: eventId } },
        create: {
          provider: 'resend',
          providerEventId: eventId,
          eventType: event.type,
          payload: event,
        },
        update: {},
      })
      if (receipt.processedAt) return
      if (event.type === 'email.received') await processInbound(eventId, event.data)
      else await processDeliveryEvent(eventId, event.type, new Date(event.created_at), event.data)
      await db.prospectEmailWebhookReceipt.update({
        where: { id: receipt.id },
        data: { processedAt: new Date(), processingError: null },
      })
    })
    return Response.json({ ok: true })
  } catch (error) {
    await withTenantIsolationBypass(() =>
      db.prospectEmailWebhookReceipt.updateMany({
        where: { provider: 'resend', providerEventId: eventId },
        data: {
          processingError:
            error instanceof Error ? error.message.slice(0, 2000) : 'Unknown processing error',
        },
      }),
    )
    return Response.json({ error: 'Processing failed' }, { status: 500 })
  }
}
