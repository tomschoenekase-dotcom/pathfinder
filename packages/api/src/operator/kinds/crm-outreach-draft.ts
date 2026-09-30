import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { reviewProspectOutreachDraftAction, saveProspectOutreachDraftAction } from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
  type StoredOperatorProposal,
} from '../proposals'
import { operatorReason } from './shared'

const input = OPERATOR_MCP_INPUTS['crm.propose_outreach_draft']
type DraftArgs = ReturnType<typeof input.parse>

type DraftSnapshot = {
  memberId: string
  latestDraftId: string | null
  latestDraftVersion: number
  latestDraftStatus: string | null
}

async function readLatest(database: OperatorDatabase, memberId: string): Promise<DraftSnapshot> {
  const latest = await database.prospectOutreachDraft.findFirst({
    where: { memberId },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, status: true },
  })
  return {
    memberId,
    latestDraftId: latest?.id ?? null,
    latestDraftVersion: latest?.version ?? 0,
    latestDraftStatus: latest?.status ?? null,
  }
}

/**
 * Saves a draft for human review through the canonical draft action. It never approves, stages or
 * sends anything; the ProspectSend tables are untouched.
 */
export const crmOutreachDraftKind: OperatorProposalKind<DraftArgs> = {
  kind: 'crm.outreach-draft',
  tool: 'crm.propose_outreach_draft',
  capability: 'crm:propose',
  parse: (raw) => input.parse(raw),
  // The contract names a campaign member, not an organization, so the member is the target.
  target: (args) => ({ ref: args.campaignMemberId }),
  authorize: async (args, context: OperatorKindContext) => {
    const member = await context.database.prospectCampaignMember.findUnique({
      where: { id: args.campaignMemberId },
      select: { id: true },
    })
    if (!member) throw new OperatorNotFoundError()
  },
  targetVersion: async (args, context) =>
    String((await readLatest(context.database, args.campaignMemberId)).latestDraftVersion),
  currentVersion: async (args, context) =>
    String((await readLatest(context.database, args.campaignMemberId)).latestDraftVersion),
  describe: (args) => ({
    title: 'Save an outreach draft for review (nothing is sent)',
    lines: [`subject: ${args.subject}`, args.textBody],
  }),
  snapshot: async (args, context) =>
    (await readLatest(context.database, args.campaignMemberId)) as unknown as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const draft = await saveProspectOutreachDraftAction(
      {
        memberId: args.campaignMemberId,
        subject: args.subject,
        textBody: args.textBody,
        groundingSnapshot: { source: 'operator', proposalId: context.proposalId },
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: {
        draftId: draft.id,
        version: draft.version,
        campaignMemberId: args.campaignMemberId,
        status: draft.status,
      },
      after: {
        draftId: draft.id,
        version: draft.version,
        status: draft.status,
        memberId: args.campaignMemberId,
      },
    }
  },
  /** Discards the draft it saved through the canonical review action (a rejection). */
  revert: async (original: StoredOperatorProposal, context: OperatorApplyContext) => {
    const after = original.afterSnapshot as { draftId?: string } | null
    if (!after?.draftId) throw new OperatorStaleError('The original snapshot is incomplete.')
    const draft = await context.database.prospectOutreachDraft.findUnique({
      where: { id: after.draftId },
      select: { id: true, status: true },
    })
    if (!draft) throw new OperatorNotFoundError()
    if (draft.status !== 'NEEDS_REVIEW') {
      throw new OperatorStaleError('The draft was already reviewed, sent or superseded.')
    }
    const reviewed = await reviewProspectOutreachDraftAction(
      {
        draftId: draft.id,
        approve: false,
        reason: `Discarded: ${operatorReason(original.id)}`,
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: { draftId: reviewed.id, status: reviewed.status },
      after: { draftId: reviewed.id, status: reviewed.status },
    }
  },
}
