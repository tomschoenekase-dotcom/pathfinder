import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  recordProspectOutreachEvidenceAction,
  amendProspectOutreachEvidenceAction,
} from '@pathfinder/db'
import {
  readOutreachHistoryState,
  requireOutreachAccount,
  requireOutreachGroupScope,
  outreachReviewActor,
  bindOutreachReview,
} from '../outreach-history'
import {
  OperatorStaleError,
  type OperatorProposalKind,
  type OperatorApplyContext,
} from '../proposals'
const reviewInput = OPERATOR_MCP_INPUTS['crm.propose_outreach_history_review']
const retractInput = OPERATOR_MCP_INPUTS['crm.propose_outreach_history_retract']
type ReviewArgs = ReturnType<typeof reviewInput.parse>
type RetractArgs = ReturnType<typeof retractInput.parse>
async function outcome(
  organizationId: string,
  receipt: { activityId: string; inserted: boolean },
  context: OperatorApplyContext,
) {
  const state = await readOutreachHistoryState(context.database, organizationId)
  return {
    result: {
      organizationId,
      receiptId: receipt.activityId,
      replayed: !receipt.inserted,
      revision: state.revision,
      projection: state.plan.projection as unknown as JsonValue,
    },
    after: {
      organizationId,
      revision: state.revision,
      receiptId: receipt.activityId,
      projection: state.plan.projection as unknown as JsonValue,
    },
  }
}
async function receiptReconcile(args: ReviewArgs | RetractArgs, context: OperatorApplyContext) {
  const receipt = await context.database.prospectActivity.findUnique({
    where: {
      externalReceiptKey: `${args.targetEvidenceId ? 'outreach-history-amend' : 'outreach-history'}:${context.operationId}`,
    },
    select: { id: true, organizationId: true },
  })
  if (!receipt) return { state: 'not_applied' as const }
  if (receipt.organizationId !== args.organizationId) return { state: 'unknown' as const }
  return {
    state: 'applied' as const,
    outcome: await outcome(
      args.organizationId,
      { activityId: receipt.id, inserted: false },
      context,
    ),
  }
}
const common = {
  capability: 'crm:propose' as const,
  target: (args: ReviewArgs | RetractArgs) => ({ ref: args.organizationId }),
  authorize: async (
    args: ReviewArgs | RetractArgs,
    context: Parameters<typeof requireOutreachAccount>[1],
  ) => {
    await requireOutreachAccount(args.organizationId, context)
    const { plan } = await readOutreachHistoryState(context.database, args.organizationId)
    await requireOutreachGroupScope(plan.organizationIds, context)
  },
  targetVersion: async (args: ReviewArgs | RetractArgs) => args.expectedRevision,
  currentVersion: async (
    args: ReviewArgs | RetractArgs,
    context: Parameters<typeof requireOutreachAccount>[1],
  ) => (await readOutreachHistoryState(context.database, args.organizationId)).revision,
  snapshot: async (
    args: ReviewArgs | RetractArgs,
    context: Parameters<typeof requireOutreachAccount>[1],
  ) => {
    const state = await readOutreachHistoryState(context.database, args.organizationId)
    return { revision: state.revision, projection: state.plan.projection } as unknown as JsonValue
  },
  reconcile: receiptReconcile,
}
export const outreachHistoryReviewKind: OperatorProposalKind<ReviewArgs> = {
  ...common,
  kind: 'crm.outreach-history-review',
  tool: 'crm.propose_outreach_history_review',
  parse: (raw) => reviewInput.parse(raw),
  describe: (args) => ({
    title: args.targetEvidenceId ? 'Correct outreach history evidence' : 'Review outreach history',
    lines: [
      `kind: ${args.change.kind}`,
      args.reason,
      'Original messages and evidence remain; no sending or suppression change.',
    ],
  }),
  apply: async (args, context) => {
    const actor = outreachReviewActor(context)
    const evidence = await bindOutreachReview(
      context.database,
      args.organizationId,
      args.change,
      actor.id,
      args.reason,
    )
    if (args.targetEvidenceId) {
      const { plan } = await readOutreachHistoryState(context.database, args.organizationId)
      const current = plan.evidence.find((item) => item.evidenceId === args.targetEvidenceId)
      if (!current)
        throw new OperatorStaleError('That evidence is no longer in the current account history.')
      const receipt = await amendProspectOutreachEvidenceAction(
        {
          organizationId: args.organizationId,
          operationId: context.operationId,
          targetEvidenceId: current.evidenceId,
          expectedRevision: args.expectedRevision,
          expectedCurrentEvidenceId: current.currentEvidenceId,
          expectedFingerprint: current.fingerprint,
          reason: args.reason,
          replacement: evidence,
          actor,
        },
        context.database,
      )
      return outcome(args.organizationId, receipt, context)
    }
    const receipt = await recordProspectOutreachEvidenceAction(
      {
        organizationId: args.organizationId,
        operationId: context.operationId,
        expectedRevision: args.expectedRevision,
        evidence,
        actor,
      },
      context.database,
    )
    return outcome(args.organizationId, receipt, context)
  },
}
export const outreachHistoryRetractKind: OperatorProposalKind<RetractArgs> = {
  ...common,
  kind: 'crm.outreach-history-retract',
  tool: 'crm.propose_outreach_history_retract',
  parse: (raw) => retractInput.parse(raw),
  describe: (args) => ({
    title: 'Retract an outreach history decision',
    lines: [
      `evidence: ${args.targetEvidenceId}`,
      args.reason,
      'Soft retraction only; actual sends and source receipts remain.',
    ],
  }),
  apply: async (args, context) => {
    const { plan } = await readOutreachHistoryState(context.database, args.organizationId)
    const current = plan.evidence.find((item) => item.evidenceId === args.targetEvidenceId)
    if (!current)
      throw new OperatorStaleError('That evidence is no longer in the current account history.')
    const receipt = await amendProspectOutreachEvidenceAction(
      {
        organizationId: args.organizationId,
        operationId: context.operationId,
        targetEvidenceId: current.evidenceId,
        expectedRevision: args.expectedRevision,
        expectedCurrentEvidenceId: current.currentEvidenceId,
        expectedFingerprint: current.fingerprint,
        reason: args.reason,
        replacement: null,
        actor: outreachReviewActor(context),
      },
      context.database,
    )
    return outcome(args.organizationId, receipt, context)
  },
}
export const CRM_OUTREACH_HISTORY_KINDS = [outreachHistoryReviewKind, outreachHistoryRetractKind]
