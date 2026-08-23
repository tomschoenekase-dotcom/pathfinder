import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type Client = typeof db

const REPLY_ADVANCE_STAGES = new Set(['CONTACTED', 'FOLLOW_UP_DUE'])

export async function recordProspectInboundReplyAction(
  input: {
    prospectOrganizationId: string
    contactId: string | null
    campaignMemberId: string | null
    canonicalMessageId: string
    canonicalThreadId: string
    matchingEvidence: readonly string[]
    occurredAt: Date
  },
  client: Client = db,
) {
  return client.$transaction(async (tx) => {
    const opportunity = await tx.prospectOpportunity.findUnique({
      where: { organizationId: input.prospectOrganizationId },
      select: { id: true, stage: true },
    })
    const shouldAdvance = opportunity ? REPLY_ADVANCE_STAGES.has(opportunity.stage) : false

    const activity = await tx.prospectActivity.create({
      data: {
        organizationId: input.prospectOrganizationId,
        contactId: input.contactId,
        type: 'REPLY_RECEIVED',
        summary: 'Inbound correspondence received',
        evidence: {
          messageId: input.canonicalMessageId,
          threadId: input.canonicalThreadId,
          matchingEvidence: [...input.matchingEvidence],
        },
        actorId: 'gmail-sync',
        occurredAt: input.occurredAt,
      },
      select: { id: true },
    })

    if (input.campaignMemberId) {
      await tx.prospectCampaignMember.updateMany({
        where: { id: input.campaignMemberId, status: { in: ['QUEUED', 'SENT'] } },
        data: { status: 'REPLIED' },
      })
    }

    if (opportunity) {
      await tx.prospectOpportunity.update({
        where: { id: opportunity.id },
        data: {
          ...(shouldAdvance ? { stage: 'REPLIED' as const } : {}),
          lastActivityAt: input.occurredAt,
          updatedBy: 'gmail-sync',
        },
      })
      if (shouldAdvance) {
        await tx.prospectStageHistory.create({
          data: {
            opportunityId: opportunity.id,
            fromStage: opportunity.stage,
            toStage: 'REPLIED',
            reason: 'Inbound correspondence matched to canonical thread',
            actorId: 'gmail-sync',
          },
        })
      }
    }

    await writeAuditLogStrict(
      {
        actorType: 'SYSTEM',
        actorId: 'gmail-sync',
        actorRole: 'SYSTEM',
        action: 'system.prospect.inbound_reply_recorded',
        targetType: opportunity ? 'ProspectOpportunity' : 'ProspectOrganization',
        targetId: opportunity?.id ?? input.prospectOrganizationId,
        sourceReferences: [
          { type: 'ProspectEmailMessage', id: input.canonicalMessageId },
          { type: 'ProspectEmailThread', id: input.canonicalThreadId },
        ],
        beforeState: { stage: opportunity?.stage ?? null },
        afterState: {
          stage: opportunity ? (shouldAdvance ? 'REPLIED' : opportunity.stage) : null,
          stageChanged: shouldAdvance,
          activityId: activity.id,
        },
      },
      tx,
    )

    return {
      activityId: activity.id,
      opportunityId: opportunity?.id ?? null,
      fromStage: opportunity?.stage ?? null,
      toStage: opportunity ? (shouldAdvance ? ('REPLIED' as const) : opportunity.stage) : null,
      stageChanged: shouldAdvance,
    }
  })
}
