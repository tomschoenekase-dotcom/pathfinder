import { createHash } from 'node:crypto'

import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  addProspectCampaignMemberAction,
  approveProspectSendBatchAction,
  createProspectCampaignAction,
  PROSPECT_OUTREACH_RELEASE_POLICY,
  releaseProspectSendBatchAction,
  reviewProspectOutreachDraftAction,
  stageProspectSendBatchAction,
} from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { OperatorNotFoundError } from '../grants'
import type { OperatorApplyContext, OperatorKindContext, OperatorProposalKind } from '../proposals'
import { isCampaignReleaseEnabled } from './release-gate'

/**
 * Campaign preparation as reviewable proposals, on the canonical campaign services. Every step that
 * gates outbound mail (draft review, batch stage, batch approve, release) is always-ask and is bound
 * to the exact hashes the human saw. Nothing here sends: release only queues through the canonical
 * release, which keeps its own delivery control, mailbox and 1 to 50 recipient gates, and the
 * adapter itself stays off unless a deployment turns it on.
 */

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

// ---------------------------------------------------------------------------
// Campaign creation and membership
// ---------------------------------------------------------------------------

const createInput = OPERATOR_MCP_INPUTS['crm.propose_campaign_create']
type CreateArgs = ReturnType<typeof createInput.parse>

export const crmCampaignCreateKind: OperatorProposalKind<CreateArgs> = {
  kind: 'crm.campaign-create',
  tool: 'crm.propose_campaign_create',
  capability: 'crm:propose',
  parse: (raw) => createInput.parse(raw),
  target: () => ({}),
  authorize: async (args, context: OperatorKindContext) => {
    const ids = [...new Set(args.organizationIds)]
    const found = await context.database.prospectOrganization.count({
      where: { id: { in: ids }, archivedAt: null },
    })
    if (found !== ids.length) throw new OperatorNotFoundError()
  },
  targetVersion: async () => null,
  currentVersion: async () => null,
  describe: (args) => ({
    title: 'Create an outreach campaign (nothing is drafted or sent)',
    lines: [
      `name: ${args.name}`,
      ...(args.description ? [`description: ${args.description}`] : []),
      `${new Set(args.organizationIds).size} accounts: ${[...new Set(args.organizationIds)].join(', ')}`,
    ],
  }),
  snapshot: async (args) => ({ accounts: new Set(args.organizationIds).size }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const campaign = await createProspectCampaignAction(
      {
        name: args.name,
        ...(args.description !== undefined ? { description: args.description } : {}),
        organizationIds: args.organizationIds,
        // The proposal id rides in the cohort snapshot so an interrupted create can be found again.
        cohortSnapshot: {
          source: 'operator',
          proposalId: context.proposalId,
          selectedAt: context.now.toISOString(),
          organizationIds: [...new Set(args.organizationIds)],
        },
        actor: context.actor,
      },
      context.database,
    )
    const members = await context.database.prospectCampaignMember.groupBy({
      by: ['status'],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    })
    return {
      result: {
        campaignId: campaign.id,
        memberCount: members.reduce((sum, row) => sum + row._count._all, 0),
        suppressedMembers: members.find((row) => row.status === 'SUPPRESSED')?._count._all ?? 0,
      },
      after: { campaignId: campaign.id },
    }
  },
  reconcile: async (_args, context) => {
    const campaign = await context.database.prospectOutreachCampaign.findFirst({
      where: { cohortSnapshot: { path: ['proposalId'], equals: context.proposalId } },
      select: { id: true, members: { select: { status: true } } },
    })
    if (!campaign) return { state: 'not_applied' }
    return {
      state: 'applied',
      outcome: {
        result: {
          campaignId: campaign.id,
          memberCount: campaign.members.length,
          suppressedMembers: campaign.members.filter((member) => member.status === 'SUPPRESSED')
            .length,
        },
        after: { campaignId: campaign.id },
      },
    }
  },
}

const membershipInput = OPERATOR_MCP_INPUTS['crm.propose_campaign_membership']
type MembershipArgs = ReturnType<typeof membershipInput.parse>

async function memberState(database: OperatorDatabase, args: MembershipArgs) {
  const members = await database.prospectCampaignMember.count({
    where: { campaignId: args.campaignId, organizationId: args.organizationId },
  })
  return String(members)
}

export const crmCampaignMembershipKind: OperatorProposalKind<MembershipArgs> = {
  kind: 'crm.campaign-membership',
  tool: 'crm.propose_campaign_membership',
  capability: 'crm:propose',
  parse: (raw) => membershipInput.parse(raw),
  target: (args) => ({ ref: args.campaignId }),
  authorize: async (args, context: OperatorKindContext) => {
    const [campaign, organization] = await Promise.all([
      context.database.prospectOutreachCampaign.findUnique({
        where: { id: args.campaignId },
        select: { id: true },
      }),
      context.database.prospectOrganization.findFirst({
        where: { id: args.organizationId, archivedAt: null },
        select: { id: true },
      }),
    ])
    if (!campaign || !organization) throw new OperatorNotFoundError()
  },
  targetVersion: async (args, context) => memberState(context.database, args),
  currentVersion: async (args, context) => memberState(context.database, args),
  describe: (args) => ({
    title: 'Add an account to a campaign (nothing is drafted or sent)',
    lines: [
      `campaign ${args.campaignId}`,
      `account ${args.organizationId}`,
      args.contactId
        ? `selected contact ${args.contactId}`
        : 'contact: first one that may be drafted to',
    ],
  }),
  snapshot: async (args, context) =>
    ({ existingMembers: await memberState(context.database, args) }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const added = await addProspectCampaignMemberAction(
      {
        campaignId: args.campaignId,
        organizationId: args.organizationId,
        ...(args.contactId !== undefined ? { contactId: args.contactId } : {}),
        ...(args.venueId !== undefined ? { venueId: args.venueId } : {}),
        receipt: `operator:${context.operationId}`,
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: {
        campaignMemberId: added.member.id,
        status: added.member.status,
        contactId: added.member.contactId,
        replayed: added.replayed,
      },
      after: { campaignMemberId: added.member.id },
    }
  },
  reconcile: async (args, context) => {
    const member = await context.database.prospectCampaignMember.findFirst({
      where: {
        campaignId: args.campaignId,
        organizationId: args.organizationId,
        selection: { path: ['receipt'], equals: `operator:${context.operationId}` },
      },
      select: { id: true, status: true, contactId: true },
    })
    if (!member) return { state: 'not_applied' }
    return {
      state: 'applied',
      outcome: {
        result: {
          campaignMemberId: member.id,
          status: member.status,
          contactId: member.contactId,
          replayed: false,
        },
        after: { campaignMemberId: member.id },
      },
    }
  },
}

// ---------------------------------------------------------------------------
// Draft review
// ---------------------------------------------------------------------------

const reviewInput = OPERATOR_MCP_INPUTS['crm.propose_draft_review']
type ReviewArgs = ReturnType<typeof reviewInput.parse>

async function readDraft(database: OperatorDatabase, draftId: string) {
  return database.prospectOutreachDraft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      memberId: true,
      campaignId: true,
      organizationId: true,
      version: true,
      status: true,
      toEmail: true,
      subject: true,
      textBody: true,
      contentHash: true,
      escalationFlags: true,
      approvedBy: true,
      rejectedReason: true,
    },
  })
}

export const crmDraftReviewKind: OperatorProposalKind<ReviewArgs> = {
  kind: 'crm.draft-review',
  tool: 'crm.propose_draft_review',
  capability: 'crm:propose',
  parse: (raw) => reviewInput.parse(raw),
  target: (args) => ({ ref: args.draftId }),
  authorize: async (args, context: OperatorKindContext) => {
    const draft = await readDraft(context.database, args.draftId)
    if (!draft) throw new OperatorNotFoundError()
    // Approval is bound to the exact content the person saw. A different hash is a different draft.
    if (draft.contentHash !== args.expectedContentHash) {
      throw Object.assign(new Error('The draft is not the content that was shown.'), {
        code: 'CONTENT_CHANGED',
      })
    }
    if (args.approve) {
      const acknowledged = new Set(args.acknowledgedEscalations ?? [])
      const missing = draft.escalationFlags.filter((flag) => !acknowledged.has(flag))
      if (missing.length > 0) {
        throw Object.assign(
          new Error(`Every escalation flag must be acknowledged by name: ${missing.join(', ')}`),
          { code: 'ESCALATION_UNACKNOWLEDGED' },
        )
      }
    }
  },
  targetVersion: async (args, context) =>
    (await readDraft(context.database, args.draftId))?.status ?? null,
  currentVersion: async (args, context) =>
    (await readDraft(context.database, args.draftId))?.status ?? null,
  describe: (args) => ({
    title: args.approve
      ? 'Approve this draft for later staging (approving sends nothing)'
      : 'Reject this draft',
    lines: [
      `draft ${args.draftId}`,
      `content hash ${args.expectedContentHash}`,
      ...(args.approve && args.acknowledgedEscalations?.length
        ? [`escalations acknowledged: ${args.acknowledgedEscalations.join(', ')}`]
        : []),
      ...(args.reason ? [`reason: ${args.reason}`] : []),
    ],
  }),
  snapshot: async (args, context) =>
    (await readDraft(context.database, args.draftId)) as unknown as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const draft = await readDraft(context.database, args.draftId)
    if (!draft) throw new OperatorNotFoundError()
    if (draft.contentHash !== args.expectedContentHash) {
      throw Object.assign(new Error('The draft is not the content that was shown.'), {
        code: 'CONFLICT',
        name: 'ProspectOutreachError',
      })
    }
    const reviewed = await reviewProspectOutreachDraftAction(
      {
        draftId: args.draftId,
        approve: args.approve,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        ...(args.acknowledgedEscalations !== undefined
          ? { acknowledgedEscalations: args.acknowledgedEscalations }
          : {}),
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: { draftId: reviewed.id, status: reviewed.status, contentHash: reviewed.contentHash },
      after: { draftId: reviewed.id, status: reviewed.status },
    }
  },
  /** The review is one transition out of NEEDS_REVIEW, so the resulting status is its own receipt. */
  reconcile: async (args, context) => {
    const draft = await readDraft(context.database, args.draftId)
    if (!draft) return { state: 'unknown' }
    const decided = args.approve
      ? draft.status === 'APPROVED' && draft.approvedBy === context.actor.id
      : draft.status === 'REJECTED' && draft.rejectedReason !== null
    if (draft.status === 'NEEDS_REVIEW') return { state: 'not_applied' }
    if (!decided) return { state: 'unknown' }
    return {
      state: 'applied',
      outcome: {
        result: { draftId: draft.id, status: draft.status, contentHash: draft.contentHash },
        after: { draftId: draft.id, status: draft.status },
      },
    }
  },
}

// ---------------------------------------------------------------------------
// Batches: stage, approve, release
// ---------------------------------------------------------------------------

const stageInput = OPERATOR_MCP_INPUTS['crm.propose_batch_stage']
type StageArgs = ReturnType<typeof stageInput.parse>

async function stagedItemFor(
  database: OperatorDatabase,
  campaignId: string,
  draft: { draftId: string; expectedContentHash: string },
) {
  return database.prospectSendItem.findUnique({
    where: {
      idempotencyKey: `torchiko-prospect-${sha256(`${campaignId}:${draft.draftId}:${draft.expectedContentHash}`)}`,
    },
    select: { batchId: true },
  })
}

export const crmBatchStageKind: OperatorProposalKind<StageArgs> = {
  kind: 'crm.batch-stage',
  tool: 'crm.propose_batch_stage',
  capability: 'crm:propose',
  parse: (raw) => stageInput.parse(raw),
  target: (args) => ({ ref: args.campaignId }),
  authorize: async (args, context: OperatorKindContext) => {
    const ids = [...new Set(args.drafts.map((draft) => draft.draftId))]
    const drafts = await context.database.prospectOutreachDraft.findMany({
      where: { id: { in: ids }, campaignId: args.campaignId },
      select: { id: true, status: true, contentHash: true },
    })
    if (drafts.length !== ids.length) throw new OperatorNotFoundError()
    const bound = new Map(args.drafts.map((draft) => [draft.draftId, draft.expectedContentHash]))
    if (drafts.some((draft) => draft.contentHash !== bound.get(draft.id))) {
      throw Object.assign(new Error('A draft is not the content that was shown.'), {
        code: 'CONTENT_CHANGED',
      })
    }
    if (ids.length > PROSPECT_OUTREACH_RELEASE_POLICY.maxRecipients) {
      throw Object.assign(new Error('The initial canary permits at most 50 recipients.'), {
        code: 'RELEASE_LIMIT',
      })
    }
  },
  targetVersion: async () => null,
  currentVersion: async () => null,
  describe: (args) => ({
    title: 'Freeze these approved drafts into a send batch (staging sends nothing)',
    lines: [
      `campaign ${args.campaignId}`,
      `${args.drafts.length} drafts, each bound to its content hash:`,
      ...args.drafts.map((draft) => `${draft.draftId} ${draft.expectedContentHash}`),
    ],
  }),
  snapshot: async (args) => ({ drafts: args.drafts.length }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const batch = await stageProspectSendBatchAction(
      {
        campaignId: args.campaignId,
        draftIds: args.drafts.map((draft) => draft.draftId),
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: {
        batchId: batch.id,
        recipientCount: batch.recipientCount,
        snapshotHash: batch.snapshotHash,
        status: batch.status,
      },
      after: { batchId: batch.id, snapshotHash: batch.snapshotHash },
    }
  },
  /** Staged items carry a database-unique key derived from campaign, draft and content hash. */
  reconcile: async (args, context) => {
    const staged = await Promise.all(
      args.drafts.map((draft) => stagedItemFor(context.database, args.campaignId, draft)),
    )
    if (staged.every((item) => item === null)) return { state: 'not_applied' }
    const batchIds = new Set(staged.map((item) => item?.batchId ?? null))
    if (batchIds.size !== 1 || batchIds.has(null)) return { state: 'unknown' }
    const batch = await context.database.prospectSendBatch.findUnique({
      where: { id: [...batchIds][0]! },
    })
    if (!batch) return { state: 'unknown' }
    return {
      state: 'applied',
      outcome: {
        result: {
          batchId: batch.id,
          recipientCount: batch.recipientCount,
          snapshotHash: batch.snapshotHash,
          status: batch.status,
        },
        after: { batchId: batch.id, snapshotHash: batch.snapshotHash },
      },
    }
  },
}

const approveInput = OPERATOR_MCP_INPUTS['crm.propose_batch_approve']
type ApproveArgs = ReturnType<typeof approveInput.parse>

async function readBatch(database: OperatorDatabase, batchId: string) {
  return database.prospectSendBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      status: true,
      recipientCount: true,
      snapshotHash: true,
      approvedBy: true,
      releasedBy: true,
    },
  })
}

export const crmBatchApproveKind: OperatorProposalKind<ApproveArgs> = {
  kind: 'crm.batch-approve',
  tool: 'crm.propose_batch_approve',
  capability: 'crm:propose',
  parse: (raw) => approveInput.parse(raw),
  target: (args) => ({ ref: args.batchId }),
  authorize: async (args, context: OperatorKindContext) => {
    const batch = await readBatch(context.database, args.batchId)
    if (!batch) throw new OperatorNotFoundError()
    if (
      batch.recipientCount !== args.expectedRecipientCount ||
      batch.snapshotHash !== args.expectedSnapshotHash
    ) {
      throw Object.assign(new Error('The batch is not the one that was shown.'), {
        code: 'CONTENT_CHANGED',
      })
    }
  },
  targetVersion: async (args, context) =>
    (await readBatch(context.database, args.batchId))?.status ?? null,
  currentVersion: async (args, context) =>
    (await readBatch(context.database, args.batchId))?.status ?? null,
  describe: (args) => ({
    title: 'Approve this staged batch (approval alone sends nothing)',
    lines: [
      `batch ${args.batchId}`,
      `${args.expectedRecipientCount} recipients`,
      `snapshot ${args.expectedSnapshotHash}`,
    ],
  }),
  snapshot: async (args, context) =>
    (await readBatch(context.database, args.batchId)) as unknown as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const approved = await approveProspectSendBatchAction(
      {
        batchId: args.batchId,
        expectedRecipientCount: args.expectedRecipientCount,
        expectedSnapshotHash: args.expectedSnapshotHash,
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: { batchId: approved.id, status: approved.status },
      after: { batchId: approved.id, status: approved.status },
    }
  },
  reconcile: async (args, context) => {
    const batch = await readBatch(context.database, args.batchId)
    if (!batch) return { state: 'unknown' }
    if (batch.status === 'STAGED') return { state: 'not_applied' }
    if (batch.approvedBy !== context.actor.id) return { state: 'unknown' }
    return {
      state: 'applied',
      outcome: {
        result: { batchId: batch.id, status: batch.status },
        after: { batchId: batch.id, status: batch.status },
      },
    }
  },
}

const releaseInput = OPERATOR_MCP_INPUTS['crm.propose_batch_release']
type ReleaseArgs = ReturnType<typeof releaseInput.parse>

/**
 * Queues an approved batch through the canonical release. Dark by default: refused outright unless
 * the deployment enables the adapter, and then still subject to every canonical gate. It creates
 * outbox operations only; sending is a separate worker behind the global delivery control.
 */
export const crmBatchReleaseKind: OperatorProposalKind<ReleaseArgs> = {
  kind: 'crm.batch-release',
  tool: 'crm.propose_batch_release',
  capability: 'crm:propose',
  parse: (raw) => releaseInput.parse(raw),
  target: (args) => ({ ref: args.batchId }),
  authorize: async (args, context: OperatorKindContext) => {
    if (!isCampaignReleaseEnabled()) {
      throw Object.assign(new Error('The campaign release adapter is not enabled.'), {
        code: 'RELEASE_DISABLED',
      })
    }
    const batch = await readBatch(context.database, args.batchId)
    if (!batch) throw new OperatorNotFoundError()
    if (
      batch.recipientCount !== args.expectedRecipientCount ||
      batch.snapshotHash !== args.expectedSnapshotHash
    ) {
      throw Object.assign(new Error('The batch is not the one that was shown.'), {
        code: 'CONTENT_CHANGED',
      })
    }
  },
  targetVersion: async (args, context) =>
    (await readBatch(context.database, args.batchId))?.status ?? null,
  currentVersion: async (args, context) =>
    (await readBatch(context.database, args.batchId))?.status ?? null,
  describe: (args) => ({
    title: 'Queue this approved batch for delivery',
    lines: [
      `batch ${args.batchId}`,
      `${args.expectedRecipientCount} recipients`,
      `snapshot ${args.expectedSnapshotHash}`,
      `mailbox ${args.providerAccountId}`,
      'Delivery still needs the global delivery control, an enabled mailbox and the recipient limit.',
    ],
  }),
  snapshot: async (args, context) =>
    (await readBatch(context.database, args.batchId)) as unknown as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    // Checked again here: the flag may have been turned off between approval and dispatch.
    if (!isCampaignReleaseEnabled()) {
      throw Object.assign(new Error('The campaign release adapter is not enabled.'), {
        code: 'RELEASE_DISABLED',
        name: 'ProspectOutreachError',
      })
    }
    const released = await releaseProspectSendBatchAction(
      {
        batchId: args.batchId,
        providerAccountId: args.providerAccountId,
        expectedRecipientCount: args.expectedRecipientCount,
        expectedSnapshotHash: args.expectedSnapshotHash,
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: {
        batchId: released.batch.id,
        status: released.batch.status,
        queuedOperations: released.operationIds.length,
      },
      after: { batchId: released.batch.id, status: released.batch.status },
    }
  },
  reconcile: async (args, context) => {
    const batch = await readBatch(context.database, args.batchId)
    if (!batch) return { state: 'unknown' }
    if (batch.status === 'APPROVED') return { state: 'not_applied' }
    if (batch.releasedBy !== context.actor.id) return { state: 'unknown' }
    return {
      state: 'applied',
      outcome: {
        result: { batchId: batch.id, status: batch.status, queuedOperations: batch.recipientCount },
        after: { batchId: batch.id, status: batch.status },
      },
    }
  },
}

export const CRM_CAMPAIGN_KINDS = [
  crmCampaignCreateKind,
  crmCampaignMembershipKind,
  crmDraftReviewKind,
  crmBatchStageKind,
  crmBatchApproveKind,
  crmBatchReleaseKind,
]
