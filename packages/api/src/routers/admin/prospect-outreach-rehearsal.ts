import {
  db,
  PROSPECT_OUTREACH_MAX_BATCH,
  PROSPECT_OUTREACH_MAX_COHORT,
  PROSPECT_OUTREACH_RELEASE_POLICY,
} from '@pathfinder/db'

type RehearsalMember = {
  id: string
  organizationId: string
  status: string
  contact: null | {
    id: string
    normalizedEmail: string | null
    emailReadiness: string
    permissionState: string
    doNotContact: boolean
    suppressedAt: Date | null
    unsubscribedAt: Date | null
    source: string | null
    provenance: unknown
    sourceImportRowId: string | null
    sources: { id: string }[]
  }
  drafts: {
    id: string
    status: string
    escalationFlags: string[]
    approvedAt: Date | null
    approvedBy: string | null
  }[]
}

type RehearsalBatch = {
  id: string
  status: string
  recipientCount: number
  snapshotHash: string
  items: {
    recipientEmailSnapshot: string
    recipientIdentityHash: string
    contentHashSnapshot: string
    status: string
    providerAccountId: string | null
    providerMessageId: string | null
  }[]
}

export type ProspectNoSendRehearsalInput = {
  campaignId: string
  generatedAt: Date
  campaignStatus: string
  campaignPausedAt: Date | null
  members: RehearsalMember[]
  batches: RehearsalBatch[]
  openDuplicateCandidateCount: number
  processDeliveryEnabled: boolean
  globalDeliveryEnabled: boolean
  internalOnly: boolean
}

function jsonHasEvidence(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0)
}

function duplicateValues(values: (string | null | undefined)[]): string[] {
  const counts = new Map<string, number>()
  for (const value of values) {
    const normalized = value?.trim().toLowerCase()
    if (normalized) counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort()
}

export function projectProspectNoSendRehearsal(input: ProspectNoSendRehearsalInput) {
  const activeBatches = input.batches.filter((batch) =>
    ['STAGED', 'APPROVED'].includes(batch.status),
  )
  const allBatchItems = activeBatches.flatMap((batch) => batch.items)
  const memberDuplicateEmails = duplicateValues(
    input.members.map((member) => member.contact?.normalizedEmail),
  )
  const frozenDuplicateEmails = duplicateValues(
    allBatchItems.map((item) => item.recipientEmailSnapshot),
  )
  const frozenDuplicateIdentities = duplicateValues(
    allBatchItems.map((item) => item.recipientIdentityHash),
  )
  const unsafeMembers = input.members.filter((member) => {
    const contact = member.contact
    return (
      !contact?.normalizedEmail ||
      contact.emailReadiness !== 'VALID' ||
      ['OPTED_OUT', 'PROHIBITED'].includes(contact.permissionState) ||
      contact.doNotContact ||
      Boolean(contact.suppressedAt) ||
      Boolean(contact.unsubscribedAt)
    )
  })
  const membersWithoutProvenance = input.members.filter((member) => {
    const contact = member.contact
    return !(
      contact?.source ||
      contact?.sourceImportRowId ||
      contact?.sources.length ||
      jsonHasEvidence(contact?.provenance)
    )
  })
  const membersWithoutDraft = input.members.filter((member) => !member.drafts[0])
  const draftsNeedingReview = input.members.filter(
    (member) => member.drafts[0]?.status === 'NEEDS_REVIEW',
  )
  const approvedDrafts = input.members.filter((member) => {
    const draft = member.drafts[0]
    return draft?.status === 'APPROVED' && draft.approvedAt && draft.approvedBy
  })
  const approvedDraftsWithoutEvidence = input.members.filter((member) => {
    const draft = member.drafts[0]
    return draft?.status === 'APPROVED' && (!draft.approvedAt || !draft.approvedBy)
  })
  const invalidFrozenBatches = activeBatches.filter(
    (batch) =>
      batch.recipientCount < 1 ||
      batch.recipientCount > PROSPECT_OUTREACH_MAX_BATCH ||
      batch.recipientCount !== batch.items.length ||
      batch.snapshotHash.length !== 64 ||
      batch.items.some(
        (item) =>
          item.recipientIdentityHash.length !== 64 ||
          item.contentHashSnapshot.length !== 64 ||
          item.status !== 'STAGED' ||
          item.providerAccountId !== null ||
          item.providerMessageId !== null,
      ),
  )
  const deliveryDark = !input.processDeliveryEnabled && !input.globalDeliveryEnabled
  const bounded =
    input.members.length > 0 &&
    input.members.length <= PROSPECT_OUTREACH_MAX_COHORT &&
    activeBatches.every((batch) => batch.recipientCount <= PROSPECT_OUTREACH_MAX_BATCH)
  const withinActiveReleaseLimit = activeBatches.every(
    (batch) => batch.recipientCount <= PROSPECT_OUTREACH_RELEASE_POLICY.maxRecipients,
  )

  const blockers = [
    ...(!deliveryDark ? ['DELIVERY_NOT_DARK'] : []),
    ...(!input.internalOnly ? ['INTERNAL_ONLY_DISABLED'] : []),
    ...(!bounded ? ['COHORT_NOT_BOUNDED'] : []),
    ...(!withinActiveReleaseLimit ? ['CANARY_RELEASE_LIMIT_EXCEEDED'] : []),
    ...(unsafeMembers.length ? ['CONTACT_SAFETY_FAILED'] : []),
    ...(membersWithoutProvenance.length ? ['CONTACT_PROVENANCE_MISSING'] : []),
    ...(memberDuplicateEmails.length ? ['DUPLICATE_MEMBER_EMAIL'] : []),
    ...(input.openDuplicateCandidateCount ? ['ORGANIZATION_DUPLICATE_UNRESOLVED'] : []),
    ...(frozenDuplicateEmails.length || frozenDuplicateIdentities.length
      ? ['DUPLICATE_FROZEN_RECIPIENT']
      : []),
    ...(membersWithoutDraft.length ? ['DRAFT_MISSING'] : []),
    ...(approvedDraftsWithoutEvidence.length ? ['APPROVAL_EVIDENCE_MISSING'] : []),
    ...(invalidFrozenBatches.length ? ['FROZEN_SNAPSHOT_INVALID'] : []),
  ]

  return {
    campaignId: input.campaignId,
    generatedAt: input.generatedAt,
    mode: 'NO_SEND_REHEARSAL' as const,
    outcome: blockers.length ? ('BLOCKED' as const) : ('READY_FOR_HUMAN_REVIEW' as const),
    readyForHumanReview: blockers.length === 0,
    readyToSend: false as const,
    blockers,
    safety: {
      deliveryDark,
      processDeliveryEnabled: input.processDeliveryEnabled,
      globalDeliveryEnabled: input.globalDeliveryEnabled,
      internalOnly: input.internalOnly,
      emergencyStopAvailable: true,
      emergencyStopDirection: 'DISABLE_ONLY' as const,
      providerRequired: false,
      providerCallsMade: 0,
      estimatedProviderCostUsd: 0,
    },
    releasePolicy: PROSPECT_OUTREACH_RELEASE_POLICY,
    cohort: {
      memberCount: input.members.length,
      maxCohort: PROSPECT_OUTREACH_MAX_COHORT,
      technicalMaxBatch: PROSPECT_OUTREACH_MAX_BATCH,
      activeReleaseLimit: PROSPECT_OUTREACH_RELEASE_POLICY.maxRecipients,
      bounded,
      withinActiveReleaseLimit,
      unsafeMemberCount: unsafeMembers.length,
      missingProvenanceCount: membersWithoutProvenance.length,
      duplicateMemberEmailCount: memberDuplicateEmails.length,
      openOrganizationDuplicateCount: input.openDuplicateCandidateCount,
    },
    review: {
      missingDraftCount: membersWithoutDraft.length,
      draftsNeedingReviewCount: draftsNeedingReview.length,
      approvedDraftCount: approvedDrafts.length,
      approvalEvidenceMissingCount: approvedDraftsWithoutEvidence.length,
    },
    frozenSnapshots: {
      activeBatchCount: activeBatches.length,
      recipientCount: allBatchItems.length,
      invalidBatchCount: invalidFrozenBatches.length,
      duplicateEmailCount: frozenDuplicateEmails.length,
      duplicateIdentityCount: frozenDuplicateIdentities.length,
      identities: activeBatches.map((batch) => ({
        batchId: batch.id,
        status: batch.status,
        recipientCount: batch.recipientCount,
        snapshotHash: batch.snapshotHash,
      })),
    },
    campaign: {
      status: input.campaignStatus,
      paused: Boolean(input.campaignPausedAt),
    },
  }
}

export async function getProspectNoSendRehearsalProjection(campaignId: string) {
  const campaign = await db.prospectOutreachCampaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      status: true,
      pausedAt: true,
      members: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          organizationId: true,
          status: true,
          contact: {
            select: {
              id: true,
              normalizedEmail: true,
              emailReadiness: true,
              permissionState: true,
              doNotContact: true,
              suppressedAt: true,
              unsubscribedAt: true,
              source: true,
              provenance: true,
              sourceImportRowId: true,
              sources: { select: { id: true }, take: 1 },
            },
          },
          drafts: {
            orderBy: { version: 'desc' },
            take: 1,
            select: {
              id: true,
              status: true,
              escalationFlags: true,
              approvedAt: true,
              approvedBy: true,
            },
          },
        },
      },
      sendBatches: {
        where: { status: { in: ['STAGED', 'APPROVED'] } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          recipientCount: true,
          snapshotHash: true,
          items: {
            orderBy: { createdAt: 'asc' },
            select: {
              recipientEmailSnapshot: true,
              recipientIdentityHash: true,
              contentHashSnapshot: true,
              status: true,
              providerAccountId: true,
              providerMessageId: true,
            },
          },
        },
      },
    },
  })
  if (!campaign) return null

  const organizationIds = [...new Set(campaign.members.map((member) => member.organizationId))]
  const [control, openDuplicateCandidateCount] = await Promise.all([
    db.prospectDeliveryControl.findUnique({ where: { id: 'global' } }),
    organizationIds.length
      ? db.prospectDuplicateCandidate.count({
          where: {
            status: 'OPEN',
            OR: [
              { organizationAId: { in: organizationIds } },
              { organizationBId: { in: organizationIds } },
            ],
          },
        })
      : Promise.resolve(0),
  ])

  return projectProspectNoSendRehearsal({
    campaignId: campaign.id,
    generatedAt: new Date(),
    campaignStatus: campaign.status,
    campaignPausedAt: campaign.pausedAt,
    members: campaign.members,
    batches: campaign.sendBatches,
    openDuplicateCandidateCount,
    processDeliveryEnabled: process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED === 'true',
    globalDeliveryEnabled: Boolean(control?.deliveryEnabled),
    internalOnly: control?.internalOnly ?? true,
  })
}
