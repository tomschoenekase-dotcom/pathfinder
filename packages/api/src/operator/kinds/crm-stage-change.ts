import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { updateProspectPipelineAction } from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { OperatorNotFoundError } from '../grants'
import type { OperatorApplyContext, OperatorKindContext, OperatorProposalKind } from '../proposals'
import { operatorReason } from './shared'

const input = OPERATOR_MCP_INPUTS['crm.propose_stage_change']
type StageArgs = ReturnType<typeof input.parse>

/**
 * The CRM has no version column, so an organization's version is 1 plus the number of activity
 * rows recorded for it. Every stage change, note and logged send adds one, so any movement since
 * the proposer looked makes the proposal stale. Read tools should report the same number.
 */
export async function prospectOrganizationVersion(
  database: OperatorDatabase,
  organizationId: string,
): Promise<number | null> {
  const opportunity = await database.prospectOpportunity.findUnique({
    where: { organizationId },
    select: { id: true },
  })
  if (!opportunity) return null
  return 1 + (await database.prospectActivity.count({ where: { organizationId } }))
}

async function readState(database: OperatorDatabase, organizationId: string) {
  const opportunity = await database.prospectOpportunity.findUnique({
    where: { organizationId },
    select: { stage: true, priority: true },
  })
  if (!opportunity) return null
  return {
    organizationId,
    stage: opportunity.stage,
    priority: opportunity.priority,
    version: await prospectOrganizationVersion(database, organizationId),
  }
}

export const crmStageChangeKind: OperatorProposalKind<StageArgs> = {
  kind: 'crm.stage-change',
  tool: 'crm.propose_stage_change',
  capability: 'crm:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ ref: args.organizationId }),
  authorize: async (args, context: OperatorKindContext) => {
    if ((await prospectOrganizationVersion(context.database, args.organizationId)) === null) {
      throw new OperatorNotFoundError()
    }
  },
  targetVersion: async (args) => String(args.expectedVersion),
  currentVersion: async (args, context) => {
    const version = await prospectOrganizationVersion(context.database, args.organizationId)
    return version === null ? null : String(version)
  },
  describe: (args) => ({
    title: 'Move prospect to another pipeline stage',
    lines: [`stage → ${args.stage}`, `organization ${args.organizationId}`],
  }),
  snapshot: async (args, context) =>
    (await readState(context.database, args.organizationId)) as unknown as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    await updateProspectPipelineAction(
      {
        organizationId: args.organizationId,
        stage: args.stage,
        reason: operatorReason(context.proposalId),
        actor: context.actor,
      },
      context.database,
    )
    const after = await readState(context.database, args.organizationId)
    return {
      result: {
        organizationId: args.organizationId,
        stage: after?.stage ?? args.stage,
        version: after?.version ?? null,
      },
      after: after as unknown as JsonValue,
    }
  },
}
