import { createHash, randomUUID } from 'node:crypto'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export const PROSPECT_PLAYBOOK_VERSION = 'torchiko-email-playbook-2026-08-18'
export const PROSPECT_OUTREACH_MAX_COHORT = 5_000
export const PROSPECT_OUTREACH_MAX_BATCH = 500

type HumanActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
type DraftActor = HumanActor | { type: 'AGENT'; id: string; capabilities: readonly string[] }
type Client = typeof db

export class ProspectOutreachError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT' | 'APPROVAL_REQUIRED' | 'SUPPRESSED',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectOutreachError'
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function json(value: unknown): object | unknown[] {
  return JSON.parse(JSON.stringify(value)) as object | unknown[]
}

function requireHuman(actor: HumanActor): void {
  if (!actor.id || actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN') {
    throw new ProspectOutreachError(
      'APPROVAL_REQUIRED',
      'A human platform administrator is required',
    )
  }
}

function requireDraftAuthority(actor: DraftActor): void {
  if (!actor.id) throw new ProspectOutreachError('INVALID_INPUT', 'Actor identity is required')
  if (actor.type === 'AGENT' && !actor.capabilities.includes('prospects:draft')) {
    throw new ProspectOutreachError('APPROVAL_REQUIRED', 'Agent lacks prospects:draft capability')
  }
}

export async function createProspectCampaignAction(
  input: {
    name: string
    description?: string
    organizationIds: readonly string[]
    cohortSnapshot: unknown
    actor: HumanActor
  },
  client: Client = db,
) {
  requireHuman(input.actor)
  const ids = [...new Set(input.organizationIds)]
  if (!input.name.trim() || ids.length < 1 || ids.length > PROSPECT_OUTREACH_MAX_COHORT) {
    throw new ProspectOutreachError(
      'INVALID_INPUT',
      'Campaign name and a bounded cohort are required',
    )
  }
  return client.$transaction(async (tx) => {
    const organizations = await tx.prospectOrganization.findMany({
      where: { id: { in: ids }, archivedAt: null },
      select: {
        id: true,
        venues: {
          where: { archivedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { id: true },
        },
        contacts: {
          where: {
            archivedAt: null,
            doNotContact: false,
            normalizedEmail: { not: null },
            emailReadiness: 'VALID',
            permissionState: { notIn: ['OPTED_OUT', 'PROHIBITED'] },
            suppressedAt: null,
            unsubscribedAt: null,
          },
          orderBy: [{ venueId: 'asc' }, { createdAt: 'asc' }],
          take: 1,
          select: { id: true, venueId: true },
        },
      },
    })
    if (organizations.length !== ids.length) {
      throw new ProspectOutreachError('NOT_FOUND', 'One or more selected prospects are unavailable')
    }
    return tx.prospectOutreachCampaign.create({
      data: {
        name: input.name.trim(),
        description: input.description?.trim() || null,
        cohortSnapshot: json(input.cohortSnapshot),
        playbookVersion: PROSPECT_PLAYBOOK_VERSION,
        createdBy: input.actor.id,
        updatedBy: input.actor.id,
        members: {
          create: organizations.map((organization) => ({
            organizationId: organization.id,
            venueId: organization.contacts[0]?.venueId ?? organization.venues[0]?.id ?? null,
            contactId: organization.contacts[0]?.id ?? null,
            status: organization.contacts[0] ? 'SELECTED' : 'SUPPRESSED',
            selection: { selectedBy: input.actor.id, selectedAt: new Date().toISOString() },
          })),
        },
      },
      include: { members: true },
    })
  })
}

const HIGH_RISK_PATTERNS: readonly [string, RegExp][] = [
  ['pricing', /\$\s*\d|\bprice|\bpricing|per month/iu],
  ['travel', /\btravel|\bvisit you|\bcome to (?:the )?venue|in[- ]person onboarding/iu],
  ['scheduling', /\bconfirmed for|\bmeet(?:ing)? (?:at|on)\b/iu],
  ['custom-commitment', /\bwe (?:will|can) build (?:a )?custom|\bguarantee|\bpromise/iu],
]

export function detectProspectDraftEscalations(input: {
  subject: string
  textBody: string
  relationshipTier?: 'STANDARD' | 'HIGH_VALUE' | 'STRATEGIC'
}): string[] {
  const content = `${input.subject}\n${input.textBody}`
  const flags = HIGH_RISK_PATTERNS.filter(([, pattern]) => pattern.test(content)).map(
    ([flag]) => flag,
  )
  if (input.relationshipTier === 'STRATEGIC') flags.push('strategic-prospect')
  return [...new Set(flags)].sort()
}

export async function saveProspectOutreachDraftAction(
  input: {
    memberId: string
    subject: string
    textBody: string
    htmlBody?: string
    groundingSnapshot: unknown
    actor: DraftActor
  },
  client: Client = db,
) {
  requireDraftAuthority(input.actor)
  const subject = input.subject.trim()
  const textBody = input.textBody.trim()
  if (!subject || !textBody || subject.length > 998 || textBody.length > 50_000) {
    throw new ProspectOutreachError(
      'INVALID_INPUT',
      'A bounded subject and message body are required',
    )
  }
  if (/\[[A-Z_ -]+\]|\{\{.+?\}\}|<[^>]*VENUE[^>]*>/u.test(`${subject}\n${textBody}`)) {
    throw new ProspectOutreachError(
      'INVALID_INPUT',
      'Unresolved template placeholders are not allowed',
    )
  }
  return client.$transaction(async (tx) => {
    const member = await tx.prospectCampaignMember.findUnique({
      where: { id: input.memberId },
      include: {
        contact: true,
        organization: { select: { relationshipTier: true } },
        drafts: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { id: true, version: true, status: true },
        },
      },
    })
    if (!member) throw new ProspectOutreachError('NOT_FOUND', 'Campaign member not found')
    if (
      !member.contact?.normalizedEmail ||
      member.contact.doNotContact ||
      member.contact.emailReadiness !== 'VALID' ||
      member.contact.permissionState === 'OPTED_OUT' ||
      member.contact.permissionState === 'PROHIBITED' ||
      member.contact.suppressedAt ||
      member.contact.unsubscribedAt
    ) {
      throw new ProspectOutreachError('SUPPRESSED', 'The selected contact is not email-ready')
    }
    const previous = member.drafts[0]
    if (previous?.status === 'QUEUED' || previous?.status === 'SENT') {
      throw new ProspectOutreachError('CONFLICT', 'Queued or sent drafts are immutable')
    }
    if (previous && previous.status !== 'SUPERSEDED') {
      await tx.prospectOutreachDraft.update({
        where: { id: previous.id },
        data: { status: 'SUPERSEDED' },
      })
    }
    const escalationFlags = detectProspectDraftEscalations({
      subject,
      textBody,
      relationshipTier: member.organization.relationshipTier,
    })
    const contentHash = hash(
      `${member.contact.normalizedEmail}\n${subject}\n${textBody}\n${input.htmlBody ?? ''}`,
    )
    const draft = await tx.prospectOutreachDraft.create({
      data: {
        campaignId: member.campaignId,
        memberId: member.id,
        organizationId: member.organizationId,
        venueId: member.venueId,
        contactId: member.contactId,
        version: (previous?.version ?? 0) + 1,
        toEmail: member.contact.normalizedEmail,
        subject,
        textBody,
        htmlBody: input.htmlBody ?? null,
        contentHash,
        groundingSnapshot: json(input.groundingSnapshot),
        escalationFlags,
        generatedByType: input.actor.type,
        generatedById: input.actor.id,
      },
    })
    await tx.prospectCampaignMember.update({
      where: { id: member.id },
      data: { status: 'NEEDS_REVIEW' },
    })
    await tx.prospectActivity.create({
      data: {
        organizationId: member.organizationId,
        venueId: member.venueId,
        contactId: member.contactId,
        type: 'OUTREACH_DRAFTED',
        summary: 'Outreach draft prepared for human review',
        evidence: { draftId: draft.id, campaignId: member.campaignId, escalationFlags },
        actorId: input.actor.id,
      },
    })
    return draft
  })
}

export async function reviewProspectOutreachDraftAction(
  input: {
    draftId: string
    approve: boolean
    reason?: string
    acknowledgedEscalations?: readonly string[]
    actor: HumanActor
  },
  client: Client = db,
) {
  requireHuman(input.actor)
  return client.$transaction(async (tx) => {
    const draft = await tx.prospectOutreachDraft.findUnique({ where: { id: input.draftId } })
    if (!draft) throw new ProspectOutreachError('NOT_FOUND', 'Draft not found')
    if (draft.status !== 'NEEDS_REVIEW')
      throw new ProspectOutreachError('CONFLICT', 'Draft is not awaiting review')
    if (input.approve) {
      const acknowledged = new Set(input.acknowledgedEscalations ?? [])
      const missing = draft.escalationFlags.filter((flag) => !acknowledged.has(flag))
      if (missing.length)
        throw new ProspectOutreachError(
          'APPROVAL_REQUIRED',
          `Explicit escalation review required: ${missing.join(', ')}`,
        )
    } else if (!input.reason?.trim()) {
      throw new ProspectOutreachError('INVALID_INPUT', 'A rejection reason is required')
    }
    const status = input.approve ? 'APPROVED' : 'REJECTED'
    const reviewed = await tx.prospectOutreachDraft.update({
      where: { id: draft.id },
      data: input.approve
        ? { status, approvedBy: input.actor.id, approvedAt: new Date() }
        : { status, rejectedReason: input.reason!.trim() },
    })
    await tx.prospectCampaignMember.update({
      where: { id: draft.memberId },
      data: { status: input.approve ? 'APPROVED' : 'NEEDS_REVIEW' },
    })
    return reviewed
  })
}

export async function stageProspectSendBatchAction(
  input: { campaignId: string; draftIds: readonly string[]; actor: HumanActor },
  client: Client = db,
) {
  requireHuman(input.actor)
  const ids = [...new Set(input.draftIds)]
  if (ids.length < 1 || ids.length > PROSPECT_OUTREACH_MAX_BATCH) {
    throw new ProspectOutreachError('INVALID_INPUT', 'A batch must contain 1–500 approved drafts')
  }
  return client.$transaction(async (tx) => {
    const drafts = await tx.prospectOutreachDraft.findMany({
      where: { id: { in: ids }, campaignId: input.campaignId, status: 'APPROVED' },
      include: {
        contact: {
          select: {
            doNotContact: true,
            normalizedEmail: true,
            emailReadiness: true,
            permissionState: true,
            suppressedAt: true,
            unsubscribedAt: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    })
    if (
      drafts.length !== ids.length ||
      drafts.some(
        (draft) =>
          draft.contact?.doNotContact ||
          !draft.contact?.normalizedEmail ||
          draft.contact.emailReadiness !== 'VALID' ||
          draft.contact.permissionState === 'OPTED_OUT' ||
          draft.contact.permissionState === 'PROHIBITED' ||
          Boolean(draft.contact.suppressedAt) ||
          Boolean(draft.contact.unsubscribedAt),
      )
    ) {
      throw new ProspectOutreachError(
        'SUPPRESSED',
        'Every staged draft must still be approved and email-ready',
      )
    }
    const snapshotHash = hash(
      drafts.map((draft) => `${draft.id}:${draft.contentHash}:${draft.toEmail}`).join('\n'),
    )
    return tx.prospectSendBatch.create({
      data: {
        campaignId: input.campaignId,
        recipientCount: drafts.length,
        snapshotHash,
        createdBy: input.actor.id,
        items: {
          create: drafts.map((draft) => ({
            memberId: draft.memberId,
            draftId: draft.id,
            recipientEmailSnapshot: draft.toEmail,
            recipientIdentityHash: hash(draft.toEmail.toLowerCase()),
            subjectSnapshot: draft.subject,
            textBodySnapshot: draft.textBody,
            htmlBodySnapshot: draft.htmlBody,
            headerSnapshot: {
              playbookVersion: PROSPECT_PLAYBOOK_VERSION,
              draftVersion: draft.version,
            },
            contentHashSnapshot: draft.contentHash,
            idempotencyKey: `torchiko-prospect-${hash(`${input.campaignId}:${draft.id}:${draft.contentHash}`)}`,
          })),
        },
      },
      include: { items: true },
    })
  })
}

export async function approveProspectSendBatchAction(
  input: {
    batchId: string
    expectedRecipientCount: number
    expectedSnapshotHash: string
    actor: HumanActor
  },
  client: Client = db,
) {
  requireHuman(input.actor)
  return client.$transaction(async (tx) => {
    const batch = await tx.prospectSendBatch.findUnique({
      where: { id: input.batchId },
      include: { items: true },
    })
    if (!batch) throw new ProspectOutreachError('NOT_FOUND', 'Send batch not found')
    if (batch.status !== 'STAGED')
      throw new ProspectOutreachError('CONFLICT', 'Only staged batches can be approved')
    if (
      batch.recipientCount !== input.expectedRecipientCount ||
      batch.snapshotHash !== input.expectedSnapshotHash ||
      batch.items.length !== batch.recipientCount
    ) {
      throw new ProspectOutreachError(
        'CONFLICT',
        'Batch confirmation does not match the frozen recipient snapshot',
      )
    }
    const approved = await tx.prospectSendBatch.update({
      where: { id: batch.id },
      data: { status: 'APPROVED', approvedBy: input.actor.id, approvedAt: new Date() },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'prospect.send-batch.approve',
        targetType: 'ProspectSendBatch',
        targetId: batch.id,
        beforeState: { status: batch.status },
        afterState: {
          status: approved.status,
          recipientCount: batch.recipientCount,
          snapshotHash: batch.snapshotHash,
        },
      },
      tx,
    )
    return approved
  })
}

/** Human-only final release. The immutable operations and batch transition commit atomically. */
export async function releaseProspectSendBatchAction(
  input: {
    batchId: string
    providerAccountId: string
    expectedRecipientCount: number
    expectedSnapshotHash: string
    actor: HumanActor
  },
  client: Client = db,
) {
  requireHuman(input.actor)
  return client.$transaction(async (tx) => {
    const [control, providerAccount, batch] = await Promise.all([
      tx.prospectDeliveryControl.findUnique({ where: { id: 'global' } }),
      tx.correspondenceProviderAccount.findUnique({ where: { id: input.providerAccountId } }),
      tx.prospectSendBatch.findUnique({
        where: { id: input.batchId },
        include: {
          campaign: true,
          items: {
            orderBy: { id: 'asc' },
            include: {
              draft: {
                include: {
                  contact: {
                    select: {
                      normalizedEmail: true,
                      doNotContact: true,
                      archivedAt: true,
                      emailReadiness: true,
                      permissionState: true,
                      suppressedAt: true,
                      unsubscribedAt: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ])

    if (!control?.deliveryEnabled) {
      throw new ProspectOutreachError('APPROVAL_REQUIRED', 'Prospect delivery is globally disabled')
    }
    if (
      !providerAccount ||
      providerAccount.provider !== 'GMAIL' ||
      providerAccount.connectionStatus !== 'CONNECTED' ||
      !providerAccount.deliveryEnabled ||
      providerAccount.pausedAt
    ) {
      throw new ProspectOutreachError(
        'APPROVAL_REQUIRED',
        'A connected, explicitly enabled Gmail mailbox is required',
      )
    }
    if (!batch || batch.status !== 'APPROVED') {
      throw new ProspectOutreachError('CONFLICT', 'Batch is not approved for release')
    }
    if (batch.campaign.pausedAt || batch.campaign.status === 'CANCELLED') {
      throw new ProspectOutreachError('CONFLICT', 'Campaign is paused or cancelled')
    }
    if (
      batch.recipientCount !== input.expectedRecipientCount ||
      batch.snapshotHash !== input.expectedSnapshotHash ||
      batch.items.length !== batch.recipientCount
    ) {
      throw new ProspectOutreachError('CONFLICT', 'Release confirmation does not match the batch')
    }

    for (const item of batch.items) {
      const contact = item.draft.contact
      const identityHash = contact?.normalizedEmail
        ? hash(contact.normalizedEmail.toLowerCase())
        : null
      const eligible =
        contact &&
        !contact.archivedAt &&
        !contact.doNotContact &&
        contact.emailReadiness === 'VALID' &&
        contact.permissionState !== 'OPTED_OUT' &&
        contact.permissionState !== 'PROHIBITED' &&
        !contact.suppressedAt &&
        !contact.unsubscribedAt &&
        identityHash === item.recipientIdentityHash
      if (!eligible) {
        throw new ProspectOutreachError(
          'SUPPRESSED',
          `Recipient ${item.id} is no longer eligible; release was not created`,
        )
      }
      if (
        control.internalOnly &&
        !control.internalAllowlist.some(
          (allowed) => allowed.toLowerCase() === item.recipientEmailSnapshot.toLowerCase(),
        )
      ) {
        throw new ProspectOutreachError(
          'APPROVAL_REQUIRED',
          'Delivery is restricted to the reviewed internal allowlist',
        )
      }
    }

    const releasedAt = new Date()
    const operations = batch.items.map((item) => ({
      id: `outbox_${randomUUID()}`,
      operationId: randomUUID(),
      sendItemId: item.id,
      providerAccountId: providerAccount.id,
      providerIdempotencyKey: item.idempotencyKey,
    }))
    await tx.prospectSendOutbox.createMany({ data: operations })
    await tx.prospectSendItem.updateMany({
      where: { batchId: batch.id, status: 'STAGED' },
      data: { status: 'QUEUED', providerAccountId: providerAccount.id },
    })
    await tx.prospectOutreachDraft.updateMany({
      where: { id: { in: batch.items.map((item) => item.draftId) }, status: 'APPROVED' },
      data: { status: 'QUEUED' },
    })
    await tx.prospectCampaignMember.updateMany({
      where: { id: { in: batch.items.map((item) => item.memberId) } },
      data: { status: 'QUEUED' },
    })
    const released = await tx.prospectSendBatch.update({
      where: { id: batch.id },
      data: {
        status: 'QUEUED',
        queuedAt: releasedAt,
        releasedAt,
        releasedBy: input.actor.id,
      },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'prospect.send-batch.release',
        targetType: 'ProspectSendBatch',
        targetId: batch.id,
        beforeState: { status: batch.status },
        afterState: {
          status: released.status,
          providerAccountId: providerAccount.id,
          recipientCount: batch.recipientCount,
          snapshotHash: batch.snapshotHash,
        },
      },
      tx,
    )
    return {
      batch: released,
      outboxIds: operations.map((operation) => operation.id),
      operationIds: operations.map((operation) => operation.operationId),
    }
  })
}
