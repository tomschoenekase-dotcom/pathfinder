import { createHash, createHmac } from 'node:crypto'

import { Resend } from 'resend'

import { db, withTenantIsolationBypass } from '@pathfinder/db'
import type { SendProspectOutreachJobPayload } from '@pathfinder/jobs'

type ResendClient = Pick<Resend, 'emails'>
let testClient: ResendClient | null | undefined

function provider(): ResendClient {
  if (testClient) return testClient
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY is not configured')
  return new Resend(key)
}

function replyAddress(threadId: string): { address?: string; tokenHash: string } {
  const secret = process.env.PROSPECT_OUTREACH_REPLY_SECRET
  const domain = process.env.PROSPECT_OUTREACH_REPLY_DOMAIN
  const token = secret
    ? createHmac('sha256', secret)
        .update(`torchiko-prospect-thread:${threadId}`)
        .digest('base64url')
    : createHash('sha256').update(`disabled:${threadId}`).digest('base64url')
  return {
    ...(secret && domain ? { address: `reply+${token}@${domain}` } : {}),
    tokenHash: createHash('sha256').update(token).digest('hex'),
  }
}

export async function processSendProspectOutreachJob(
  payload: SendProspectOutreachJobPayload,
): Promise<void> {
  if (process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED !== 'true') {
    throw new Error('Prospect outreach delivery is disabled')
  }
  const from = process.env.RESEND_FROM_EMAIL
  if (!from) throw new Error('RESEND_FROM_EMAIL is not configured')

  await withTenantIsolationBypass(async () => {
    const item = await db.prospectSendItem.findUnique({
      where: { id: payload.sendItemId },
      include: {
        batch: true,
        draft: true,
        member: { include: { contact: true, organization: { include: { opportunity: true } } } },
      },
    })
    if (!item) throw new Error('Prospect send item not found')
    if (['SENT', 'DELIVERED'].includes(item.status)) return
    if (!['APPROVED', 'QUEUED', 'PROCESSING'].includes(item.batch.status))
      throw new Error('Send batch is not approved')
    if (item.draft.status !== 'QUEUED' || item.draft.contentHash !== item.contentHashSnapshot)
      throw new Error('Frozen draft integrity check failed')
    if (
      item.member.contact?.doNotContact ||
      item.member.contact?.normalizedEmail !== item.recipientEmailSnapshot
    ) {
      await db.prospectSendItem.update({
        where: { id: item.id },
        data: {
          status: 'SUPPRESSED',
          lastErrorCode: 'CONTACT_SUPPRESSED',
          lastErrorMessage: 'Contact became suppressed before delivery',
        },
      })
      return
    }
    const claimed = await db.prospectSendItem.updateMany({
      where: { id: item.id, status: { in: ['STAGED', 'QUEUED', 'SENDING', 'FAILED'] } },
      data: {
        status: 'SENDING',
        attemptCount: { increment: 1 },
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    })
    if (!claimed.count) return

    const threadId = `pt_${createHash('sha256').update(item.id).digest('hex').slice(0, 24)}`
    const reply = replyAddress(threadId)
    let response: Awaited<ReturnType<ResendClient['emails']['send']>>
    try {
      response = await provider().emails.send(
        {
          from: `Tom Schoenekase · Torchiko <${from}>`,
          to: item.recipientEmailSnapshot,
          subject: item.subjectSnapshot,
          text: item.draft.textBody,
          ...(item.draft.htmlBody ? { html: item.draft.htmlBody } : {}),
          ...(reply.address ? { replyTo: reply.address } : {}),
        },
        { idempotencyKey: item.idempotencyKey },
      )
      if (response.error || !response.data?.id)
        throw new Error('Outreach provider rejected the request')
    } catch (error) {
      await db.prospectSendItem.update({
        where: { id: item.id },
        data: {
          status: 'FAILED',
          lastErrorCode: 'PROVIDER_SEND_FAILED',
          lastErrorMessage:
            error instanceof Error ? error.message.slice(0, 2000) : 'Unknown provider error',
        },
      })
      throw error
    }
    const sentAt = new Date()
    await db.$transaction(async (tx) => {
      const thread = await tx.prospectEmailThread.upsert({
        where: { replyTokenHash: reply.tokenHash },
        create: {
          id: threadId,
          organizationId: item.member.organizationId,
          venueId: item.member.venueId,
          contactId: item.member.contactId,
          subject: item.subjectSnapshot,
          replyTokenHash: reply.tokenHash,
          lastMessageAt: sentAt,
        },
        update: { lastMessageAt: sentAt },
      })
      const message = await tx.prospectEmailMessage.create({
        data: {
          threadId: thread.id,
          organizationId: item.member.organizationId,
          venueId: item.member.venueId,
          contactId: item.member.contactId,
          sendItemId: item.id,
          direction: 'OUTBOUND',
          status: 'SENT',
          providerMessageId: response.data!.id,
          fromAddress: from,
          toAddresses: [item.recipientEmailSnapshot],
          subject: item.subjectSnapshot,
          textBody: item.draft.textBody,
          htmlBody: item.draft.htmlBody,
          occurredAt: sentAt,
        },
      })
      await tx.prospectSendItem.update({
        where: { id: item.id },
        data: { status: 'SENT', providerMessageId: response.data!.id, sentAt },
      })
      await tx.prospectOutreachDraft.update({
        where: { id: item.draftId },
        data: { status: 'SENT' },
      })
      await tx.prospectCampaignMember.update({
        where: { id: item.memberId },
        data: { status: 'SENT' },
      })
      const opportunity = item.member.organization.opportunity
      if (
        opportunity &&
        [
          'DISCOVERED',
          'RESEARCHED',
          'NEEDS_REVIEW',
          'READY_FOR_OUTREACH',
          'FOLLOW_UP_DUE',
        ].includes(opportunity.stage)
      ) {
        await tx.prospectOpportunity.update({
          where: { id: opportunity.id },
          data: {
            stage: 'CONTACTED',
            nextAction: 'First follow-up',
            nextActionAt: new Date(sentAt.getTime() + 13 * 86_400_000),
            lastActivityAt: sentAt,
            updatedBy: 'system:prospect-email',
          },
        })
        await tx.prospectStageHistory.create({
          data: {
            opportunityId: opportunity.id,
            fromStage: opportunity.stage,
            toStage: 'CONTACTED',
            reason: 'Approved outreach sent',
            actorId: 'system:prospect-email',
            evidence: { messageId: message.id, sendItemId: item.id },
          },
        })
        await tx.prospectFollowup.create({
          data: {
            organizationId: item.member.organizationId,
            opportunityId: opportunity.id,
            dueAt: new Date(sentAt.getTime() + 13 * 86_400_000),
            sequenceNumber: 1,
            reason: 'No-response follow-up per Torchiko email playbook',
          },
        })
      }
      await tx.prospectActivity.create({
        data: {
          organizationId: item.member.organizationId,
          venueId: item.member.venueId,
          contactId: item.member.contactId,
          type: 'OUTREACH_SENT',
          summary: 'Approved outreach sent',
          evidence: {
            messageId: message.id,
            sendItemId: item.id,
            campaignId: item.batch.campaignId,
          },
          actorId: 'system:prospect-email',
          occurredAt: sentAt,
        },
      })
    })
    const unfinished = await db.prospectSendItem.count({
      where: { batchId: item.batchId, status: { in: ['STAGED', 'QUEUED', 'SENDING'] } },
    })
    if (!unfinished) {
      const failed = await db.prospectSendItem.count({
        where: {
          batchId: item.batchId,
          status: { in: ['FAILED', 'SUPPRESSED', 'BOUNCED', 'COMPLAINED'] },
        },
      })
      await db.prospectSendBatch.update({
        where: { id: item.batchId },
        data: { status: failed ? 'PARTIAL' : 'COMPLETE', completedAt: new Date() },
      })
    }
  })
}

export function _setProspectOutreachResendClientForTesting(
  client: ResendClient | null | undefined,
): void {
  testClient = client
}
