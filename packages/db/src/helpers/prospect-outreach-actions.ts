import { launchAttachmentsFromSnapshot } from '@pathfinder/contracts/venue-launch-asset-node'
import { requireSameLaunchAttachments, prospectOperationalContentHash } from './prospect-launch-attachments'
import type { SalesTransaction } from './prospect-sales-snapshot'
import type { NativeOriginVerifier } from './prospect-native-origin'
import {
  requireProspectApprovalActor,
  requireProspectApprovalScope,
  isLocalFakeDelivery,
  operationalOrigin,
  validateOperationalNativeOrigin,
  type ProspectApprovalActor,
} from './prospect-native-origin'
import { salesHash } from './prospect-sales-snapshot'
import { createHash, randomUUID } from 'node:crypto'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export const PROSPECT_PLAYBOOK_VERSION = 'torchiko-email-playbook-2026-08-18'
export const PROSPECT_OUTREACH_MAX_COHORT = 5_000
export const PROSPECT_OUTREACH_MAX_BATCH = 500
export const PROSPECT_OUTREACH_RELEASE_POLICY = Object.freeze({
  phase: 'INITIAL_CANARY' as const,
  maxRecipients: 50,
  nextPhase: 'EVALUATED_CANARY' as const,
  nextPhaseMaxRecipients: 100,
  promotionStatus: 'NOT_AUTHORIZED' as const,
  promotionRequirement: 'REVIEWED_EVIDENCE_AND_CODE_CHANGE' as const,
})

type HumanActor = ProspectApprovalActor
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
  try {
    requireProspectApprovalActor(actor)
  } catch {
    throw new ProspectOutreachError(
      'APPROVAL_REQUIRED',
      'A human platform administrator is required',
    )
  }
}

export function requireProspectOutreachReleasePolicy(recipientCount: number): void {
  if (
    !Number.isInteger(recipientCount) ||
    recipientCount < 1 ||
    recipientCount > PROSPECT_OUTREACH_RELEASE_POLICY.maxRecipients
  ) {
    throw new ProspectOutreachError(
      'INVALID_INPUT',
      `The ${PROSPECT_OUTREACH_RELEASE_POLICY.phase.toLowerCase().replaceAll('_', ' ')} permits 1–${PROSPECT_OUTREACH_RELEASE_POLICY.maxRecipients} recipients; promotion requires reviewed evidence and a code change`,
    )
  }
}

function requireDraftAuthority(actor: DraftActor): void {
  if (!actor.id) throw new ProspectOutreachError('INVALID_INPUT', 'Actor identity is required')
  if (actor.type !== 'AGENT') requireHuman(actor)
  if (actor.type === 'AGENT' && !actor.capabilities.includes('prospects:draft')) {
    throw new ProspectOutreachError('APPROVAL_REQUIRED', 'Agent lacks prospects:draft capability')
  }
}

export type ProspectCampaignCreateInput = {
  name: string
  description?: string
  organizationIds: readonly string[]
  cohortSnapshot: unknown
  actor: HumanActor
  selectedContacts?: Record<string, { contactId: string; venueId: string }>
}

export async function createProspectCampaignAction(
  input: ProspectCampaignCreateInput,
  client: Client = db,
  verify?: NativeOriginVerifier,
) {
  requireHuman(input.actor)
  return client.$transaction((tx) => createProspectCampaignActionInTransaction(input, tx, verify), {
    isolationLevel: 'Serializable',
    timeout: 30_000,
  })
}

export async function createProspectCampaignActionInTransaction(
  input: ProspectCampaignCreateInput,
  tx: SalesTransaction,
  verify?: NativeOriginVerifier,
) {
  requireHuman(input.actor)
  const ids = [...new Set(input.organizationIds)]
  requireProspectApprovalScope(input.actor, ids)
  if (!input.name.trim() || ids.length < 1 || ids.length > PROSPECT_OUTREACH_MAX_COHORT) {
    throw new ProspectOutreachError(
      'INVALID_INPUT',
      'Campaign name and a bounded cohort are required',
    )
  }
  const organizations = await tx.prospectOrganization.findMany({
    where: { id: { in: ids }, archivedAt: null },
    select: {
      id: true,
      venues: {
        where: {
          archivedAt: null,
          ...(input.selectedContacts
            ? { id: { in: Object.values(input.selectedContacts).map((c) => c.venueId) } }
            : {}),
        },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { id: true },
      },
      contacts: {
        where: {
          ...(input.selectedContacts
            ? { id: { in: Object.values(input.selectedContacts).map((c) => c.contactId) } }
            : {}),
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
  if (
    input.selectedContacts &&
    (Object.keys(input.selectedContacts).length !== ids.length ||
      organizations.some((o) => {
        const selected = input.selectedContacts?.[o.id]
        return (
          !selected ||
          selected.contactId !== o.contacts[0]?.id ||
          selected.venueId !== o.venues[0]?.id ||
          (o.contacts[0]?.venueId !== null && o.contacts[0]?.venueId !== selected.venueId)
        )
      }))
  )
    throw new ProspectOutreachError(
      'CONFLICT',
      'Explicit native venue/contact selection no longer matches; no replacement recipient chosen',
    )
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
          venueId:
            input.selectedContacts?.[organization.id]?.venueId ??
            organization.contacts[0]?.venueId ??
            organization.venues[0]?.id ??
            null,
          contactId: organization.contacts[0]?.id ?? null,
          status: organization.contacts[0] ? 'SELECTED' : 'SUPPRESSED',
          selection: {
            selectedBy: input.actor.id,
            selectedByType: input.actor.type,
            syntheticRehearsal: input.actor.type === 'SYSTEM',
            selectedAt: new Date().toISOString(),
          },
        })),
      },
    },
    include: { members: true },
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

export type ProspectOperationalDraftInput = {
  memberId: string
  subject: string
  textBody: string
  htmlBody?: string
  groundingSnapshot: unknown
  actor: DraftActor
}

export async function saveProspectOutreachDraftAction(
  input: ProspectOperationalDraftInput,
  client: Client = db,
  verify?: NativeOriginVerifier,
) {
  requireDraftAuthority(input.actor)
  return client.$transaction(
    (tx) => saveProspectOutreachDraftActionInTransaction(input, tx, verify),
    { isolationLevel: 'Serializable', timeout: 30_000 },
  )
}

export async function saveProspectOutreachDraftActionInTransaction(
  input: ProspectOperationalDraftInput,
  tx: SalesTransaction,
  verify?: NativeOriginVerifier,
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
  const member = await tx.prospectCampaignMember.findUnique({
    where: { id: input.memberId },
    include: {
      contact: true,
      organization: { select: { relationshipTier: true } },
      drafts: {
        orderBy: { version: 'desc' },
        take: 1,
        select: { id: true, version: true, status: true, groundingSnapshot: true },
      },
    },
  })
  if (!member) throw new ProspectOutreachError('NOT_FOUND', 'Campaign member not found')
  if (input.actor.type === 'SYSTEM')
    requireProspectApprovalScope(input.actor, [member.organizationId])
  const origin = operationalOrigin(input.groundingSnapshot)
  if (origin && (input.subject !== subject || input.textBody !== textBody || input.htmlBody))
    throw new ProspectOutreachError(
      'CONFLICT',
      'Native handoff must retain exact reviewed subject/body bytes, without trimming or HTML replacement',
    )
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
  if (previous && operationalOrigin(previous.groundingSnapshot) && !origin)
    throw new ProspectOutreachError(
      'CONFLICT',
      'A native-origin candidate cannot drop its source and meaning-review lineage; revise through the native owner',
    )
  if (previous?.status === 'QUEUED' || previous?.status === 'SENT') {
    throw new ProspectOutreachError('CONFLICT', 'Queued or sent drafts are immutable')
  }
  const invalidationReason = `DRAFT_SUPERSEDED:${previous?.id ?? 'none'}`
  if (previous) {
    const affectedBatches = await tx.prospectSendBatch.findMany({
      where: {
        status: { in: ['STAGED', 'APPROVED'] },
        items: { some: { draftId: previous.id } },
      },
      select: { id: true },
    })
    if (affectedBatches.length) {
      const batchIds = affectedBatches.map((batch) => batch.id)
      await tx.prospectSendBatch.updateMany({
        where: { id: { in: batchIds }, status: { in: ['STAGED', 'APPROVED'] } },
        data: { status: 'CANCELLED', cancelledReason: invalidationReason },
      })
      await tx.prospectSendItem.updateMany({
        where: { batchId: { in: batchIds }, status: 'STAGED' },
        data: {
          status: 'CANCELLED',
          lastErrorCode: 'DRAFT_SUPERSEDED',
          lastErrorMessage: 'A newer draft version invalidated this frozen send intent',
        },
      })
    }
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
  const contentHash = prospectOperationalContentHash(member.contact.normalizedEmail, subject, textBody, input.htmlBody ?? '', input.groundingSnapshot)
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
      generatedByType: origin
        ? (origin.generatedBy.type as 'HUMAN' | 'AGENT' | 'SYSTEM')
        : input.actor.type,
      generatedById: origin?.generatedBy.id ?? input.actor.id,
    },
  })
  await validateOperationalNativeOrigin(draft, tx, verify)
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
}

export async function reviewProspectOutreachDraftAction(
  input: {
    draftId: string
    approve: boolean
    reason?: string
    acknowledgedEscalations?: readonly string[]
    expectedContentHash?: string
    actor: HumanActor
  },
  client: Client = db,
  verify?: NativeOriginVerifier,
) {
  requireHuman(input.actor)
  return client.$transaction(
    async (tx) => {
      const draft = await tx.prospectOutreachDraft.findUnique({ where: { id: input.draftId } })
      if (!draft) throw new ProspectOutreachError('NOT_FOUND', 'Draft not found')
      requireProspectApprovalScope(input.actor, [draft.organizationId])
      if (draft.preparationKey || !draft.memberId || !draft.campaignId || !draft.toEmail)
        throw new ProspectOutreachError(
          'APPROVAL_REQUIRED',
          'NO-SEND preparation is not a campaign approval candidate',
        )
      if (draft.status !== 'NEEDS_REVIEW')
        throw new ProspectOutreachError('CONFLICT', 'Draft is not awaiting review')
      if (operationalOrigin(draft.groundingSnapshot)) {
        if (input.expectedContentHash !== draft.contentHash)
          throw new ProspectOutreachError(
            'CONFLICT',
            'Exact operational content hash required for review',
          )
        await validateOperationalNativeOrigin(draft, tx, verify)
      }
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
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          actorType: input.actor.type,
          action: input.approve
            ? 'prospect.outreach-draft.approve'
            : 'prospect.outreach-draft.reject',
          targetType: 'ProspectOutreachDraft',
          targetId: draft.id,
          afterState: {
            contentHash: draft.contentHash,
            status,
            syntheticRehearsal: input.actor.type === 'SYSTEM',
          },
        },
        tx,
      )
      return reviewed
    },
    { isolationLevel: 'Serializable', timeout: 30_000 },
  )
}

export async function stageProspectSendBatchAction(
  input: {
    campaignId: string
    draftIds: readonly string[]
    actor: HumanActor
    expectedContentHashes?: Record<string, string>
  },
  client: Client = db,
  verify?: NativeOriginVerifier,
) {
  requireHuman(input.actor)
  const ids = [...new Set(input.draftIds)]
  requireProspectOutreachReleasePolicy(ids.length)
  return client.$transaction(
    async (tx) => {
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
            Boolean(draft.preparationKey) ||
            !draft.memberId ||
            !draft.toEmail ||
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
      requireProspectApprovalScope(
        input.actor,
        drafts.map((d) => d.organizationId),
      )
      for (const draft of drafts) {
        if (
          operationalOrigin(draft.groundingSnapshot) &&
          input.expectedContentHashes?.[draft.id] !== draft.contentHash
        )
          throw new ProspectOutreachError(
            'CONFLICT',
            'Exact reviewed content hash required for native-origin staging',
          )
        await validateOperationalNativeOrigin(draft, tx, verify)
      }
      const snapshotHash = hash(
        drafts.map((draft) => `${draft.id}:${draft.contentHash}:${draft.toEmail}`).join('\n'),
      )
      const existing = await tx.prospectSendBatch.findFirst({
        where: {
          campaignId: input.campaignId,
          snapshotHash,
          status: { in: ['STAGED', 'APPROVED', 'QUEUED', 'COMPLETE'] },
        },
        include: { items: true },
      })
      if (existing) return existing
      return tx.prospectSendBatch.create({
        data: {
          campaignId: input.campaignId,
          recipientCount: drafts.length,
          snapshotHash,
          createdBy: input.actor.id,
          items: {
            create: drafts.map((draft) => ({
              memberId: draft.memberId!,
              draftId: draft.id,
              recipientEmailSnapshot: draft.toEmail!,
              recipientIdentityHash: hash(draft.toEmail!.toLowerCase()),
              subjectSnapshot: draft.subject,
              textBodySnapshot: draft.textBody,
              htmlBodySnapshot: draft.htmlBody,
              headerSnapshot: {
                ...(launchAttachmentsFromSnapshot(draft.groundingSnapshot).length ? { launchAttachments: launchAttachmentsFromSnapshot(draft.groundingSnapshot) } : {}),
                playbookVersion: PROSPECT_PLAYBOOK_VERSION,
                draftVersion: draft.version,
                ...(operationalOrigin(draft.groundingSnapshot)
                  ? {
                      nativeSalesOrigin: json(operationalOrigin(draft.groundingSnapshot)),
                      nativeOriginHash: salesHash(operationalOrigin(draft.groundingSnapshot)),
                    }
                  : {}),
              },
              providerAccountId:
                operationalOrigin(draft.groundingSnapshot)?.providerAccountId ?? null,
              contentHashSnapshot: draft.contentHash,
              idempotencyKey: `torchiko-prospect-${hash(`${input.campaignId}:${draft.id}:${draft.contentHash}`)}`,
            })),
          },
        },
        include: { items: true },
      })
    },
    { isolationLevel: 'Serializable', timeout: 30_000 },
  )
}

export async function approveProspectSendBatchAction(
  input: {
    batchId: string
    expectedRecipientCount: number
    expectedSnapshotHash: string
    actor: HumanActor
  },
  client: Client = db,
  verify?: NativeOriginVerifier,
) {
  requireHuman(input.actor)
  return client.$transaction(
    async (tx) => {
      const batch = await tx.prospectSendBatch.findUnique({
        where: { id: input.batchId },
        include: { items: { include: { draft: true } } },
      })
      if (!batch) throw new ProspectOutreachError('NOT_FOUND', 'Send batch not found')
      if (batch.status !== 'STAGED')
        throw new ProspectOutreachError('CONFLICT', 'Only staged batches can be approved')
      requireProspectOutreachReleasePolicy(batch.recipientCount)
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
      if (input.actor.type === 'SYSTEM')
        requireProspectApprovalScope(
          input.actor,
          batch.items.map((i) => i.draft.organizationId),
        )
      for (const item of batch.items) {
        if (
          item.draft &&
          (item.draft.status !== 'APPROVED' ||
            !item.draft.approvedBy ||
            !item.draft.approvedAt ||
            item.draft.toEmail !== item.recipientEmailSnapshot ||
            item.draft.contentHash !== item.contentHashSnapshot ||
            item.draft.subject !== item.subjectSnapshot ||
            item.draft.textBody !== item.textBodySnapshot ||
            item.draft.htmlBody !== item.htmlBodySnapshot)
        )
          throw new ProspectOutreachError(
            'CONFLICT',
            'Exact approved draft and frozen content changed before batch confirmation',
          )
        if (item.draft) {
          requireSameLaunchAttachments(item.draft.groundingSnapshot, item.headerSnapshot)
          await validateOperationalNativeOrigin(item.draft, tx, verify)
        }
      }
      const computed = hash(
        [...batch.items]
          .sort((a, b) => a.draftId.localeCompare(b.draftId))
          .map((i) => `${i.draftId}:${i.contentHashSnapshot}:${i.recipientEmailSnapshot}`)
          .join('\n'),
      )
      if (computed !== batch.snapshotHash)
        throw new ProspectOutreachError(
          'CONFLICT',
          'Frozen recipient/content count hash does not reproduce',
        )
      const approved = await tx.prospectSendBatch.update({
        where: { id: batch.id },
        data: { status: 'APPROVED', approvedBy: input.actor.id, approvedAt: new Date() },
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          actorType: input.actor.type,
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
    },
    { isolationLevel: 'Serializable', timeout: 30_000 },
  )
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
  verify?: NativeOriginVerifier,
) {
  requireHuman(input.actor)
  return client.$transaction(
    async (tx) => {
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

      if (batch) requireProspectOutreachReleasePolicy(batch.recipientCount)
      const rehearsal = isLocalFakeDelivery(
        providerAccount,
        batch?.items.map((i) => i.draft.organizationId) ?? [],
        batch?.items.map((i) => i.recipientEmailSnapshot) ?? [],
      )
      if (input.actor.type === 'SYSTEM' && !rehearsal)
        throw new ProspectOutreachError(
          'APPROVAL_REQUIRED',
          'SYSTEM rehearsal release is restricted to a disabled isolated FAKE account and synthetic recipients',
        )
      if (!rehearsal && !control?.deliveryEnabled) {
        throw new ProspectOutreachError(
          'APPROVAL_REQUIRED',
          'Prospect delivery is globally disabled',
        )
      }
      if (
        !rehearsal &&
        (!providerAccount ||
          providerAccount.provider !== 'GMAIL' ||
          !providerAccount.capabilities.includes('SEND') ||
          providerAccount.connectionStatus !== 'CONNECTED' ||
          !providerAccount.deliveryEnabled ||
          providerAccount.pausedAt)
      ) {
        throw new ProspectOutreachError(
          'APPROVAL_REQUIRED',
          'A connected, explicitly enabled Gmail mailbox is required',
        )
      }
      if (!batch || batch.status !== 'APPROVED') {
        throw new ProspectOutreachError('CONFLICT', 'Batch is not approved for release')
      }
      if (!providerAccount)
        throw new ProspectOutreachError('NOT_FOUND', 'Provider account not found')
      requireProspectApprovalScope(
        input.actor,
        batch.items.map((i) => i.draft.organizationId),
      )
      requireProspectOutreachReleasePolicy(batch.recipientCount)
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
      if (
        batch.items.some(
          (item) =>
            Boolean(item.draft.preparationKey) ||
            !item.draft.toEmail ||
            item.draft.status !== 'APPROVED' ||
            item.draft.contentHash !== item.contentHashSnapshot ||
            item.draft.toEmail.toLowerCase() !== item.recipientEmailSnapshot.toLowerCase(),
        )
      ) {
        throw new ProspectOutreachError(
          'CONFLICT',
          'A draft or recipient changed after staging; create and review a new batch',
        )
      }
      const currentFrozenHash = hash(
        [...batch.items]
          .sort((a, b) => a.draftId.localeCompare(b.draftId))
          .map((i) => `${i.draftId}:${i.contentHashSnapshot}:${i.recipientEmailSnapshot}`)
          .join('\n'),
      )
      if (currentFrozenHash !== batch.snapshotHash)
        throw new ProspectOutreachError('CONFLICT', 'Frozen content hash changed after approval')

      for (const item of batch.items) {
        requireSameLaunchAttachments(item.draft.groundingSnapshot, item.headerSnapshot)
        const origin = await validateOperationalNativeOrigin(item.draft, tx, verify)
        if (rehearsal && !origin)
          throw new ProspectOutreachError(
            'CONFLICT',
            'Local rehearsal must originate from an actual native preparation and assessment',
          )
        if (
          origin &&
          (origin.providerAccountId !== providerAccount.id ||
            item.providerAccountId !== providerAccount.id ||
            salesHash(operationalOrigin(item.draft.groundingSnapshot)) !==
              (item.headerSnapshot as Record<string, unknown>).nativeOriginHash ||
            item.draft.subject !== item.subjectSnapshot ||
            item.draft.textBody !== item.textBodySnapshot ||
            item.draft.htmlBody !== item.htmlBodySnapshot)
        )
          throw new ProspectOutreachError(
            'CONFLICT',
            'Frozen account, reviewed content or native origin changed; release held',
          )
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
          !rehearsal &&
          control?.internalOnly &&
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
          actorType: input.actor.type,
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
    },
    { isolationLevel: 'Serializable', timeout: 30_000 },
  )
}
