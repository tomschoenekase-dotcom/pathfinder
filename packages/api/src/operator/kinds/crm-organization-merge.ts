import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  mergeProspectOrganizationsAction,
  previewProspectOrganizationMergeAction,
  ProspectActionError,
} from '@pathfinder/db'

import { OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorProposalKind,
} from '../proposals'

const input = OPERATOR_MCP_INPUTS['crm.propose_organization_merge']
type Args = ReturnType<typeof input.parse>

const readPlan = async (args: Args, database: OperatorApplyContext['database']) =>
  previewProspectOrganizationMergeAction(
    {
      sourceOrganizationId: args.sourceOrganizationId,
      targetOrganizationId: args.targetOrganizationId,
    },
    database,
  )

export const crmOrganizationMergeKind: OperatorProposalKind<Args> = {
  kind: 'crm.organization-merge',
  tool: 'crm.propose_organization_merge',
  capability: 'crm:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ ref: args.sourceOrganizationId }),
  authorize: async (args, context) => {
    if (!context.grant.allTenants || !context.allowedUserIds?.has(context.grant.userId)) {
      throw new OperatorNotFoundError()
    }
    let plan
    try {
      plan = await readPlan(args, context.database)
    } catch (error) {
      if (error instanceof ProspectActionError && error.code === 'NOT_FOUND') {
        throw new OperatorNotFoundError()
      }
      throw error
    }
    if (plan.planHash !== args.expectedPlanHash) {
      throw new OperatorStaleError(
        'The accounts changed since the merge preview.',
        plan as JsonValue,
      )
    }
    if (plan.blockers.length) {
      throw Object.assign(new Error('Merge has unresolved conflicts.'), {
        code: 'UNSAFE_MERGE',
        details: plan,
      })
    }
  },
  targetVersion: async (args) => args.expectedPlanHash,
  currentVersion: async (args, context) => (await readPlan(args, context.database)).planHash,
  describe: (args) => ({
    title: 'Merge two CRM accounts',
    lines: [
      `archive duplicate ${args.sourceOrganizationId}`,
      `keep canonical account ${args.targetOrganizationId}`,
      `reviewed plan ${args.expectedPlanHash.slice(0, 12)}`,
      `reason: ${args.note}`,
      'Moves contacts, venues and outreach history; retains the original opportunity snapshot.',
    ],
  }),
  snapshot: async (args, context) =>
    (await readPlan(args, context.database)) as unknown as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    let applied
    try {
      applied = await mergeProspectOrganizationsAction(
        {
          sourceOrganizationId: args.sourceOrganizationId,
          targetOrganizationId: args.targetOrganizationId,
          expectedPlanHash: args.expectedPlanHash,
          note: args.note,
          actor: context.actor,
        },
        context.database,
      )
    } catch (error) {
      if (error instanceof ProspectActionError && error.code === 'CONFLICT') {
        throw new OperatorStaleError(error.message)
      }
      throw error
    }
    return {
      result: {
        mergeId: applied.receipt.id,
        sourceOrganizationId: args.sourceOrganizationId,
        targetOrganizationId: args.targetOrganizationId,
        movedCounts: applied.receipt.movedCounts as unknown as JsonValue,
        replayed: applied.replayed,
      },
      after: {
        mergeId: applied.receipt.id,
        sourceOrganizationId: args.sourceOrganizationId,
        targetOrganizationId: args.targetOrganizationId,
      },
    }
  },
  reconcile: async (args, context) => {
    const receipt = await context.database.prospectOrganizationMerge.findUnique({
      where: { sourceOrganizationId: args.sourceOrganizationId },
    })
    if (!receipt) return { state: 'not_applied' }
    if (
      receipt.targetOrganizationId !== args.targetOrganizationId ||
      receipt.planHash !== args.expectedPlanHash
    ) {
      return { state: 'unknown' }
    }
    return {
      state: 'applied',
      outcome: {
        result: {
          mergeId: receipt.id,
          sourceOrganizationId: args.sourceOrganizationId,
          targetOrganizationId: args.targetOrganizationId,
          movedCounts: receipt.movedCounts as unknown as JsonValue,
          replayed: true,
        },
        after: {
          mergeId: receipt.id,
          sourceOrganizationId: args.sourceOrganizationId,
          targetOrganizationId: args.targetOrganizationId,
        },
      },
    }
  },
}
