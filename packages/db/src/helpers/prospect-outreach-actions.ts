import { createHash, randomUUID } from 'node:crypto'

import {
  launchAttachmentsFromSnapshot,
  launchAttachmentsSha256,
} from '@pathfinder/contracts/venue-launch-asset-node'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import {
  prospectOperationalContentHash,
  requireCurrentProspectLaunchAttachments,
  requireSameLaunchAttachments,
} from './prospect-launch-attachments'

export const PROSPECT_PLAYBOOK_VERSION = 'torchiko-email-playbook-2026-08-18'
export const PROSPECT_OUTREACH_MAX_COHORT = 5_000
export const PROSPECT_OUTREACH_MAX_BATCH = 500
export const PROSPECT_OUTREACH_COMPANY_SENDER = 'tomschoenekase@torchiko.com'
export const PROSPECT_OUTREACH_RELEASE_POLICY = Object.freeze({
  phase: 'INITIAL_CANARY' as const,
  maxRecipients: 50,
  nextPhase: 'EVALUATED_CANARY' as const,
  nextPhaseMaxRecipients: 100,
  promotionStatus: 'NOT_AUTHORIZED' as const,
  promotionRequirement: 'REVIEWED_EVIDENCE_AND_CODE_CHANGE' as const,
})

type HumanActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
type DraftActor = HumanActor | { type: 'AGENT'; id: string; capabilities: readonly string[] }
type Client = typeof db
type VerifiedCurrentProspectPrintAsset = Readonly<{
  prospectVenueId: string
  asset: VenueLaunchAsset
}>

const MAX_DRAFT_SOURCE_EVIDENCE = 20

function resolvedSourceEvidenceSnapshot(snapshot: unknown, evidence: unknown[]) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return evidence.length ? { resolvedSourceEvidence: evidence } : snapshot
  }
  const record = snapshot as Record<string, unknown>
  if (!evidence.length && !Object.hasOwn(record, 'resolvedSourceEvidence')) return snapshot
  const rest = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== 'resolvedSourceEvidence'),
  )
  return evidence.length ? { ...rest, resolvedSourceEvidence: evidence } : rest
}

export class ProspectOutreachError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT' | 'APPROVAL_REQUIRED' | 'SUPPRESSED',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectOutreachError'
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function json(value: unknown): object | unknown[] {
  return JSON.parse(JSON.stringify(value)) as object | unknown[]
}

async function currentDraftLaunchAttachments(
  prospectVenueId: string | null,
  snapshot: unknown,
  client: Parameters<Parameters<Client['$transaction']>[0]>[0],
  verifiedCurrentPrintAssets: readonly VerifiedCurrentProspectPrintAsset[] = [],
  allowFrozenVerifiedPrintAttachments = false,
): Promise<VenueLaunchAsset[]> {
  try {
    const attachments = launchAttachmentsFromSnapshot(snapshot)
    if (!attachments.length) return attachments
    if (!prospectVenueId) {
      throw new ProspectOutreachError(
        'CONFLICT',
        'Launch attachments require an active prospect venue',
      )
    }
    const proof = verifiedCurrentPrintAssets
      .filter((entry) => entry.prospectVenueId === prospectVenueId)
      .map((entry) => entry.asset)
    const current = await requireCurrentProspectLaunchAttachments(prospectVenueId, attachments, {
      client,
      verifiedCurrentPrintAssets: proof,
      ...(allowFrozenVerifiedPrintAttachments ? { allowFrozenVerifiedPrintAttachments: true } : {}),
    })
    requireSameLaunchAttachments({ launchAttachments: attachments }, { launchAttachments: current })
    return current
  } catch (error) {
    if (error instanceof ProspectOutreachError) throw error
    throw new ProspectOutreachError(
      'CONFLICT',
      error instanceof Error ? error.message : 'Launch attachment selection is invalid',
    )
  }
}

function snapshotWithLaunchAttachments(snapshot: unknown, attachments: VenueLaunchAsset[]) {
  if (!attachments.length) return snapshot
  const record =
    snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)
      : {}
  return { ...record, launchAttachments: attachments }
}

function requireHuman(actor: HumanActor): void {
  if (!actor.id || actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN') {
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
            // A campaign can retain drafts while a contact still needs human
            // readiness review. Send staging and release keep the VALID gate.
            emailReadiness: { not: 'INVALID' },
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
    sourceEvidenceIds?: readonly string[]
    verifiedCurrentPrintAssets?: readonly VerifiedCurrentProspectPrintAsset[]
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
    const sourceEvidenceIds = input.sourceEvidenceIds
    if (sourceEvidenceIds !== undefined) {
      if (
        sourceEvidenceIds.length < 1 ||
        sourceEvidenceIds.length > MAX_DRAFT_SOURCE_EVIDENCE ||
        sourceEvidenceIds.some((id) => !id.trim()) ||
        new Set(sourceEvidenceIds).size !== sourceEvidenceIds.length
      ) {
        throw new ProspectOutreachError(
          'INVALID_INPUT',
          `Between 1 and ${MAX_DRAFT_SOURCE_EVIDENCE} distinct source evidence IDs are required`,
        )
      }
    }
    if (
      !member.contact?.normalizedEmail ||
      member.contact.doNotContact ||
      member.contact.emailReadiness === 'INVALID' ||
      member.contact.permissionState === 'OPTED_OUT' ||
      member.contact.permissionState === 'PROHIBITED' ||
      member.contact.suppressedAt ||
      member.contact.unsubscribedAt
    ) {
      throw new ProspectOutreachError('SUPPRESSED', 'The selected contact is not email-ready')
    }
    let draftGroundingSnapshot = resolvedSourceEvidenceSnapshot(input.groundingSnapshot, [])
    if (sourceEvidenceIds !== undefined) {
      const evidence = await tx.prospectSourceEvidence.findMany({
        where: {
          id: { in: [...sourceEvidenceIds] },
          organizationId: member.organizationId,
          AND: [
            { OR: [{ venueId: null }, { venueId: member.venueId }] },
            { OR: [{ contactId: null }, { contactId: member.contactId }] },
          ],
        },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          organizationId: true,
          venueId: true,
          contactId: true,
          sourceType: true,
          sourceUrl: true,
          sourceLabel: true,
          capturedValue: true,
          importRowId: true,
          researchedAt: true,
          createdBy: true,
          createdAt: true,
        },
      })
      if (evidence.length !== sourceEvidenceIds.length) {
        throw new ProspectOutreachError(
          'NOT_FOUND',
          'One or more source evidence records are missing or outside the campaign member scope',
        )
      }
      const resolved = evidence.map((item) => {
        const fields = {
          id: item.id,
          organizationId: item.organizationId,
          venueId: item.venueId,
          contactId: item.contactId,
          sourceType: item.sourceType,
          sourceUrl: item.sourceUrl,
          sourceLabel: item.sourceLabel,
          capturedValue: item.capturedValue,
          importRowId: item.importRowId,
          researchedAt: item.researchedAt?.toISOString() ?? null,
          createdBy: item.createdBy,
          createdAt: item.createdAt.toISOString(),
        }
        return { ...fields, sha256: hash(JSON.stringify(fields)) }
      })
      draftGroundingSnapshot = resolvedSourceEvidenceSnapshot(draftGroundingSnapshot, resolved)
    }
    const launchAttachments = await currentDraftLaunchAttachments(
      member.venueId,
      draftGroundingSnapshot,
      tx,
      input.verifiedCurrentPrintAssets,
    )
    const groundingSnapshot = snapshotWithLaunchAttachments(
      draftGroundingSnapshot,
      launchAttachments,
    )
    const previous = member.drafts[0]
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
    const contentHash = prospectOperationalContentHash(
      member.contact.normalizedEmail,
      subject,
      textBody,
      input.htmlBody ?? '',
      groundingSnapshot,
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
        groundingSnapshot: json(groundingSnapshot),
        escalationFlags,
        generatedByType: input.actor.type,
        generatedById: input.actor.id,
      },
    })
    await tx.prospectCampaignMember.update({
      where: { id: member.id },
      data: { status: 'DRAFTED' },
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

/** Attach a previously reopened Gmail draft to one exact CRM draft version. */
export async function linkExistingProspectGmailDraftAction(
  input: {
    outreachDraftId: string
    providerAccountId: string
    providerDraftId: string
    providerMessageId: string
    expectedContentHash: string
    historyReviewConfirmed: boolean
    actor: HumanActor
  },
  client: Client = db,
) {
  requireHuman(input.actor)
  const providerDraftId = input.providerDraftId.trim()
  const providerMessageId = input.providerMessageId.trim()
  if (
    !input.outreachDraftId.trim() ||
    !input.providerAccountId.trim() ||
    !providerDraftId ||
    !providerMessageId ||
    providerDraftId.length > 191 ||
    providerMessageId.length > 191 ||
    input.historyReviewConfirmed !== true ||
    !/^[a-f0-9]{64}$/u.test(input.expectedContentHash)
  ) {
    throw new ProspectOutreachError(
      'INVALID_INPUT',
      'Exact Gmail IDs and CRM content hash are required',
    )
  }

  const sameLink = (link: {
    outreachDraftId: string
    providerAccountId: string
    providerDraftId: string
    providerMessageId: string
    contentHash: string
  }) =>
    link.outreachDraftId === input.outreachDraftId &&
    link.providerAccountId === input.providerAccountId &&
    link.providerDraftId === providerDraftId &&
    link.providerMessageId === providerMessageId &&
    link.contentHash === input.expectedContentHash

  const findExisting = async (dbClient: Client) =>
    dbClient.prospectOutreachDraftGmailLink.findFirst({
      where: {
        OR: [
          { outreachDraftId: input.outreachDraftId },
          { providerAccountId: input.providerAccountId, providerDraftId },
          { providerAccountId: input.providerAccountId, providerMessageId },
        ],
      },
    })

  try {
    return await client.$transaction(async (tx) => {
      const existing = await findExisting(tx as Client)
      if (existing) {
        if (sameLink(existing)) return existing
        throw new ProspectOutreachError(
          'CONFLICT',
          'A Gmail draft or CRM draft version is already linked',
        )
      }

      const [providerAccount, draft] = await Promise.all([
        tx.correspondenceProviderAccount.findUnique({ where: { id: input.providerAccountId } }),
        tx.prospectOutreachDraft.findUnique({
          where: { id: input.outreachDraftId },
          include: {
            contact: true,
            member: {
              include: {
                contact: true,
                organization: { include: { opportunity: true } },
                drafts: { orderBy: { version: 'desc' }, take: 1, select: { id: true } },
              },
            },
          },
        }),
      ])
      if (!providerAccount || !draft) {
        throw new ProspectOutreachError('NOT_FOUND', 'Gmail account or CRM draft was not found')
      }
      if (
        providerAccount.provider !== 'GMAIL' ||
        providerAccount.connectionStatus !== 'CONNECTED' ||
        providerAccount.mailboxAddress.trim().toLowerCase() !== PROSPECT_OUTREACH_COMPANY_SENDER
      ) {
        throw new ProspectOutreachError(
          'CONFLICT',
          'A connected Torchiko Gmail account is required',
        )
      }
      if (
        draft.status !== 'NEEDS_REVIEW' ||
        draft.member.status !== 'DRAFTED' ||
        draft.member.drafts[0]?.id !== draft.id ||
        draft.contentHash !== input.expectedContentHash
      ) {
        throw new ProspectOutreachError(
          'CONFLICT',
          'The CRM draft is no longer the current review version',
        )
      }
      const contact = draft.contact
      if (
        !contact ||
        contact.id !== draft.member.contactId ||
        draft.organizationId !== draft.member.organizationId ||
        draft.venueId !== draft.member.venueId ||
        !contact.normalizedEmail ||
        contact.normalizedEmail.toLowerCase() !== draft.toEmail.trim().toLowerCase() ||
        contact.doNotContact ||
        contact.emailReadiness !== 'VALID' ||
        !['LEGITIMATE_INTEREST_RECORDED', 'OPTED_IN'].includes(contact.permissionState) ||
        contact.permissionState === 'OPTED_OUT' ||
        contact.permissionState === 'PROHIBITED' ||
        contact.suppressedAt ||
        contact.unsubscribedAt ||
        contact.archivedAt
      ) {
        throw new ProspectOutreachError(
          'SUPPRESSED',
          'The CRM contact is suppressed or no longer matches',
        )
      }
      if (contact.sourceImportRowId) {
        const sourceRow = await tx.prospectImportRow.findUnique({
          where: { id: contact.sourceImportRowId },
          select: {
            status: true,
            import: { select: { status: true, failedRows: true, duplicateRows: true } },
          },
        })
        if (
          !sourceRow ||
          sourceRow.status !== 'IMPORTED' ||
          !['COMPLETE', 'PARTIAL'].includes(sourceRow.import.status) ||
          sourceRow.import.failedRows !== 0 ||
          sourceRow.import.duplicateRows !== 0
        ) {
          throw new ProspectOutreachError(
            'CONFLICT',
            'The source import must reach a terminal state first',
          )
        }
      }
      const stage = draft.member.organization.opportunity?.stage
      if (
        !stage ||
        !['DISCOVERED', 'RESEARCHED', 'NEEDS_REVIEW', 'READY_FOR_OUTREACH'].includes(stage)
      ) {
        throw new ProspectOutreachError(
          'CONFLICT',
          'Existing outreach or relationship history blocks this link',
        )
      }
      const [priorMessage, activeRelationship] = await Promise.all([
        tx.prospectEmailMessage.findFirst({
          where: { organizationId: draft.organizationId },
          select: { id: true },
        }),
        tx.prospectCustomerRelationship.findFirst({
          where: { organizationId: draft.organizationId, status: 'ACTIVE' },
          select: { id: true },
        }),
      ])
      if (priorMessage || activeRelationship) {
        throw new ProspectOutreachError(
          'CONFLICT',
          'Existing CRM correspondence or customer relationship blocks this link',
        )
      }

      const created = await tx.prospectOutreachDraftGmailLink.create({
        data: {
          providerAccountId: input.providerAccountId,
          outreachDraftId: draft.id,
          providerDraftId,
          providerMessageId,
          contentHash: draft.contentHash,
          verificationStatus: 'UNVERIFIED',
          createdBy: input.actor.id,
        },
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'prospect.outreach-draft.gmail-link.create',
          targetType: 'ProspectOutreachDraftGmailLink',
          targetId: created.id,
          afterState: {
            providerAccountId: created.providerAccountId,
            outreachDraftId: created.outreachDraftId,
            providerDraftId: created.providerDraftId,
            providerMessageId: created.providerMessageId,
            contentHash: created.contentHash,
            historyReviewConfirmed: input.historyReviewConfirmed,
          },
        },
        tx,
      )
      return created
    })
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const existing = await findExisting(client)
    if (existing && sameLink(existing)) return existing
    throw new ProspectOutreachError(
      'CONFLICT',
      'A Gmail draft or CRM draft version is already linked',
    )
  }
}

export async function reviewProspectOutreachDraftAction(
  input: {
    draftId: string
    approve: boolean
    reason?: string
    acknowledgedEscalations?: readonly string[]
    verifiedCurrentPrintAssets?: readonly VerifiedCurrentProspectPrintAsset[]
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
    const launchAttachments = await currentDraftLaunchAttachments(
      draft.venueId,
      draft.groundingSnapshot,
      tx,
      input.verifiedCurrentPrintAssets,
    )
    const reviewedContentHash = prospectOperationalContentHash(
      draft.toEmail,
      draft.subject,
      draft.textBody,
      draft.htmlBody ?? '',
      { launchAttachments },
    )
    if (reviewedContentHash !== draft.contentHash) {
      throw new ProspectOutreachError(
        'CONFLICT',
        'Draft content or launch attachments changed before review',
      )
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
    return reviewed
  })
}

export async function stageProspectSendBatchAction(
  input: {
    campaignId: string
    draftIds: readonly string[]
    verifiedCurrentPrintAssets?: readonly VerifiedCurrentProspectPrintAsset[]
    actor: HumanActor
  },
  client: Client = db,
) {
  requireHuman(input.actor)
  const ids = [...new Set(input.draftIds)]
  requireProspectOutreachReleasePolicy(ids.length)
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
          !['LEGITIMATE_INTEREST_RECORDED', 'OPTED_IN'].includes(draft.contact.permissionState) ||
          Boolean(draft.contact.suppressedAt) ||
          Boolean(draft.contact.unsubscribedAt),
      )
    ) {
      throw new ProspectOutreachError(
        'SUPPRESSED',
        'Every staged draft must still be approved and email-ready',
      )
    }
    const frozenDrafts = await Promise.all(
      drafts.map(async (draft) => {
        const launchAttachments = await currentDraftLaunchAttachments(
          draft.venueId,
          draft.groundingSnapshot,
          tx,
          input.verifiedCurrentPrintAssets,
        )
        const currentContentHash = prospectOperationalContentHash(
          draft.toEmail,
          draft.subject,
          draft.textBody,
          draft.htmlBody ?? '',
          { launchAttachments },
        )
        if (currentContentHash !== draft.contentHash) {
          throw new ProspectOutreachError(
            'CONFLICT',
            'Draft content or launch attachments changed before staging',
          )
        }
        return { draft, launchAttachments }
      }),
    )
    const snapshotHash = hash(
      frozenDrafts
        .map(
          ({ draft, launchAttachments }) =>
            `${draft.id}:${draft.contentHash}:${draft.toEmail}` +
            (launchAttachments.length ? `:${launchAttachmentsSha256(launchAttachments)}` : ''),
        )
        .join('\n'),
    )
    return tx.prospectSendBatch.create({
      data: {
        campaignId: input.campaignId,
        recipientCount: drafts.length,
        snapshotHash,
        createdBy: input.actor.id,
        items: {
          create: frozenDrafts.map(({ draft, launchAttachments }) => ({
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
              ...(launchAttachments.length
                ? {
                    launchAttachments,
                    launchAttachmentsSha256: launchAttachmentsSha256(launchAttachments),
                  }
                : {}),
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
    verifiedCurrentPrintAssets?: readonly VerifiedCurrentProspectPrintAsset[]
    actor: HumanActor
  },
  client: Client = db,
) {
  requireHuman(input.actor)
  return client.$transaction(async (tx) => {
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
    const frozenAttachmentSnapshot = await Promise.all(
      batch.items.map(async (item) => {
        try {
          const draftAttachments = launchAttachmentsFromSnapshot(item.draft.groundingSnapshot)
          const frozenAttachments = launchAttachmentsFromSnapshot(item.headerSnapshot)
          requireSameLaunchAttachments(
            { launchAttachments: draftAttachments },
            { launchAttachments: frozenAttachments },
          )
          const reviewedContentHash = prospectOperationalContentHash(
            item.recipientEmailSnapshot,
            item.subjectSnapshot,
            item.textBodySnapshot,
            item.htmlBodySnapshot ?? '',
            { launchAttachments: frozenAttachments },
          )
          if (
            item.draft.contentHash !== item.contentHashSnapshot ||
            reviewedContentHash !== item.contentHashSnapshot
          ) {
            throw new Error('Frozen content hash does not include the reviewed launch attachment')
          }
          await currentDraftLaunchAttachments(
            item.draft.venueId,
            { launchAttachments: frozenAttachments },
            tx,
            input.verifiedCurrentPrintAssets,
          )
          return {
            draftId: item.draftId,
            contentHash: item.contentHashSnapshot,
            recipient: item.recipientEmailSnapshot,
            launchAttachmentsSha256: frozenAttachments.length
              ? launchAttachmentsSha256(frozenAttachments)
              : null,
          }
        } catch (error) {
          throw new ProspectOutreachError(
            'CONFLICT',
            error instanceof Error
              ? error.message
              : 'Frozen launch attachment selection is invalid',
          )
        }
      }),
    )
    const recomputedSnapshotHash = hash(
      frozenAttachmentSnapshot
        .sort((left, right) => left.draftId.localeCompare(right.draftId))
        .map(
          ({ draftId, contentHash, recipient, launchAttachmentsSha256: attachmentHash }) =>
            `${draftId}:${contentHash}:${recipient}` + (attachmentHash ? `:${attachmentHash}` : ''),
        )
        .join('\n'),
    )
    if (recomputedSnapshotHash !== batch.snapshotHash) {
      throw new ProspectOutreachError(
        'CONFLICT',
        'Frozen batch hash does not bind the approved attachments',
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
    verifiedCurrentPrintAssets?: readonly VerifiedCurrentProspectPrintAsset[]
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
      !providerAccount.capabilities.includes('SEND') ||
      providerAccount.connectionStatus !== 'CONNECTED' ||
      !providerAccount.deliveryEnabled ||
      providerAccount.pausedAt ||
      providerAccount.mailboxAddress.trim().toLowerCase() !== PROSPECT_OUTREACH_COMPANY_SENDER
    ) {
      throw new ProspectOutreachError(
        'APPROVAL_REQUIRED',
        'A connected, explicitly enabled Gmail mailbox is required',
      )
    }
    if (!batch || batch.status !== 'APPROVED') {
      throw new ProspectOutreachError('CONFLICT', 'Batch is not approved for release')
    }
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

    for (const item of batch.items) {
      const draftAttachments = launchAttachmentsFromSnapshot(item.draft.groundingSnapshot)
      const frozenAttachments = launchAttachmentsFromSnapshot(item.headerSnapshot)
      try {
        requireSameLaunchAttachments(
          { launchAttachments: draftAttachments },
          { launchAttachments: frozenAttachments },
        )
      } catch (error) {
        throw new ProspectOutreachError(
          'CONFLICT',
          error instanceof Error ? error.message : 'Frozen launch attachments changed after review',
        )
      }
      const currentContentHash = prospectOperationalContentHash(
        item.recipientEmailSnapshot,
        item.subjectSnapshot,
        item.textBodySnapshot,
        item.htmlBodySnapshot ?? '',
        { launchAttachments: frozenAttachments },
      )
      if (currentContentHash !== item.contentHashSnapshot) {
        throw new ProspectOutreachError(
          'CONFLICT',
          'Frozen send content or launch attachments changed',
        )
      }
      await currentDraftLaunchAttachments(
        item.draft.venueId,
        { launchAttachments: frozenAttachments },
        tx,
        input.verifiedCurrentPrintAssets,
      )
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
        ['LEGITIMATE_INTEREST_RECORDED', 'OPTED_IN'].includes(contact.permissionState) &&
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
