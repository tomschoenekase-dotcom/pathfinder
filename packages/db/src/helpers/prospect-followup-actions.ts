import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type Client = typeof db
type HumanActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }

export class ProspectFollowupError extends Error {
  constructor(
    readonly code: 'APPROVAL_REQUIRED' | 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectFollowupError'
  }
}

export async function scheduleProspectFollowupAction(
  input: {
    triggerSendItemId: string
    sequenceNumber: 1 | 2
    dueAt: Date
    reason: string
    actor: HumanActor
    now?: Date
  },
  client: Client = db,
) {
  if (!input.actor.id || input.actor.type !== 'HUMAN' || input.actor.role !== 'PLATFORM_ADMIN') {
    throw new ProspectFollowupError(
      'APPROVAL_REQUIRED',
      'A human administrator must approve each follow-up policy schedule',
    )
  }
  const now = input.now ?? new Date()
  const reason = input.reason.trim()
  if (
    !reason ||
    reason.length > 1_000 ||
    input.dueAt <= now ||
    !([1, 2] as readonly number[]).includes(input.sequenceNumber)
  ) {
    throw new ProspectFollowupError(
      'INVALID_INPUT',
      'A future due time and bounded human policy reason are required',
    )
  }
  return client.$transaction(async (tx) => {
    const trigger = await tx.prospectSendItem.findUnique({
      where: { id: input.triggerSendItemId },
      include: {
        member: {
          include: { contact: true, organization: { include: { opportunity: true } } },
        },
      },
    })
    if (!trigger || trigger.status !== 'SENT' || !trigger.sentAt) {
      throw new ProspectFollowupError('NOT_FOUND', 'A sent originating correspondence is required')
    }
    const { member } = trigger
    const opportunity = member.organization.opportunity
    if (!opportunity || !member.contactId || !member.contact) {
      throw new ProspectFollowupError(
        'CONFLICT',
        'Follow-up requires the original campaign member, contact, and opportunity',
      )
    }
    const inboundReply = await tx.prospectEmailMessage.count({
      where: {
        organizationId: member.organizationId,
        direction: 'INBOUND',
        occurredAt: { gt: trigger.sentAt },
      },
    })
    if (inboundReply || member.status === 'REPLIED') {
      throw new ProspectFollowupError('CONFLICT', 'A reply already exists; follow-up is prohibited')
    }
    const contact = member.contact
    if (
      contact.archivedAt ||
      contact.doNotContact ||
      contact.emailReadiness !== 'VALID' ||
      ['OPTED_OUT', 'PROHIBITED'].includes(contact.permissionState) ||
      contact.suppressedAt ||
      contact.unsubscribedAt ||
      ['BOUNCED', 'SUPPRESSED', 'FAILED', 'CANCELLED'].includes(member.status)
    ) {
      throw new ProspectFollowupError('CONFLICT', 'Contact is not eligible for follow-up')
    }
    if (!['CONTACTED', 'FOLLOW_UP_DUE'].includes(opportunity.stage)) {
      throw new ProspectFollowupError(
        'CONFLICT',
        'Opportunity state does not permit automated follow-up preparation',
      )
    }
    const followup = await tx.prospectFollowup.create({
      data: {
        organizationId: member.organizationId,
        opportunityId: opportunity.id,
        campaignMemberId: member.id,
        triggerSendItemId: trigger.id,
        sequenceNumber: input.sequenceNumber,
        dueAt: input.dueAt,
        reason,
        policyApprovedBy: input.actor.id,
        policyApprovedAt: now,
      },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'prospect.followup.schedule',
        targetType: 'ProspectFollowup',
        targetId: followup.id,
        beforeState: {},
        afterState: {
          sequenceNumber: followup.sequenceNumber,
          dueAt: followup.dueAt.toISOString(),
          triggerSendItemId: trigger.id,
          policyApprovedBy: input.actor.id,
        },
      },
      tx,
    )
    return followup
  })
}

/** Rechecks policy and correspondence state. READY_FOR_DRAFT is not send authority. */
export async function evaluateProspectFollowupReadinessAction(
  input: { followupId: string; now?: Date },
  client: Client = db,
): Promise<'NOT_DUE' | 'READY_FOR_DRAFT' | 'HELD_REPLY' | 'HELD_OPPORTUNITY' | 'CANCELLED'> {
  const now = input.now ?? new Date()
  return client.$transaction(async (tx) => {
    const followup = await tx.prospectFollowup.findUnique({
      where: { id: input.followupId },
      include: {
        opportunity: true,
        campaignMember: { include: { contact: true } },
        triggerSendItem: true,
      },
    })
    if (!followup) throw new ProspectFollowupError('NOT_FOUND', 'Follow-up not found')
    if (followup.status !== 'PENDING') return 'CANCELLED'
    if (followup.dueAt > now) return 'NOT_DUE'
    if (
      !followup.policyApprovedAt ||
      !followup.policyApprovedBy ||
      !followup.campaignMember ||
      !followup.triggerSendItem?.sentAt
    ) {
      await tx.prospectFollowup.update({
        where: { id: followup.id },
        data: { status: 'CANCELLED', cancelledAt: now, reason: 'INCOMPLETE_FOLLOWUP_LINEAGE' },
      })
      return 'CANCELLED'
    }
    const replyCount = await tx.prospectEmailMessage.count({
      where: {
        organizationId: followup.organizationId,
        direction: 'INBOUND',
        occurredAt: { gt: followup.triggerSendItem.sentAt },
      },
    })
    if (replyCount || followup.campaignMember.status === 'REPLIED') {
      await tx.prospectFollowup.update({
        where: { id: followup.id },
        data: {
          status: 'ON_HOLD_REPLY_RECEIVED',
          readinessCheckedAt: now,
          reason: 'Reply received before follow-up preparation',
        },
      })
      return 'HELD_REPLY'
    }
    const contact = followup.campaignMember.contact
    if (
      !contact ||
      contact.archivedAt ||
      contact.doNotContact ||
      contact.emailReadiness !== 'VALID' ||
      ['OPTED_OUT', 'PROHIBITED'].includes(contact.permissionState) ||
      contact.suppressedAt ||
      contact.unsubscribedAt ||
      ['BOUNCED', 'SUPPRESSED', 'FAILED', 'CANCELLED'].includes(followup.campaignMember.status)
    ) {
      await tx.prospectFollowup.update({
        where: { id: followup.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          readinessCheckedAt: now,
          reason: 'Contact became ineligible before follow-up preparation',
        },
      })
      return 'CANCELLED'
    }
    if (!['CONTACTED', 'FOLLOW_UP_DUE'].includes(followup.opportunity.stage)) {
      await tx.prospectFollowup.update({
        where: { id: followup.id },
        data: {
          status: 'ON_HOLD_OPPORTUNITY',
          readinessCheckedAt: now,
          reason: `Opportunity stage ${followup.opportunity.stage} blocks follow-up preparation`,
        },
      })
      return 'HELD_OPPORTUNITY'
    }
    await tx.prospectFollowup.update({
      where: { id: followup.id },
      data: { status: 'READY_FOR_DRAFT', readinessCheckedAt: now },
    })
    return 'READY_FOR_DRAFT'
  })
}
