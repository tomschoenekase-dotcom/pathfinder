import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  assertOffboardingGate,
  readOffboardingExecutionAction,
  readOffboardingExecutionFacts,
  type OffboardingExecutionFacts,
} from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { OperatorNotFoundError } from '../grants'
import {
  executeOffboardingPlan,
  mapOffboardingError,
  offboardingOutcome,
  OFFBOARDING_SUMMARY,
  reinstateOffboardingExecution,
  type OffboardingExecutionHooks,
} from '../offboarding-execution'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
  type OperatorUnknownResolution,
  type StoredOperatorProposal,
} from '../proposals'
import { isOffboardingExecutionEnabled } from './release-gate'

const input = OPERATOR_MCP_INPUTS['offboarding.propose_execution']
type ExecutionArgs = ReturnType<typeof input.parse>

let hooks: OffboardingExecutionHooks = {}

/** Test seam only. Production never sets hooks. */
export function setOffboardingHooksForTests(next: OffboardingExecutionHooks | null) {
  hooks = next ?? {}
}

const disabled = () =>
  Object.assign(new Error('Offboarding execution is not enabled on this deployment.'), {
    code: 'DISABLED',
  })

/** A lookup or gate failure becomes the operator's own named refusal, never a raw database error. */
function refusal(error: unknown): never {
  const mapped = mapOffboardingError(error)
  if (mapped && typeof mapped === 'object' && (mapped as { code?: unknown }).code === 'NOT_FOUND') {
    throw new OperatorNotFoundError()
  }
  if (mapped && typeof mapped === 'object' && (mapped as { code?: unknown }).code === 'STALE') {
    throw new OperatorStaleError((mapped as Error).message)
  }
  throw mapped
}

async function readFacts(
  database: OperatorDatabase,
  args: ExecutionArgs,
): Promise<OffboardingExecutionFacts> {
  try {
    return await readOffboardingExecutionFacts(
      { tenantId: args.tenantId, planId: args.planId },
      database,
    )
  } catch (error) {
    return refusal(error)
  }
}

/** The plan and the billing picture as the approver saw them; any change makes the approval stale. */
function versionOf(facts: OffboardingExecutionFacts): string {
  const agreements = facts.billing.agreements
    .map((agreement) => `${agreement.billingMode}:${agreement.status}`)
    .sort()
    .join(',')
  return [
    facts.plan.status,
    facts.plan.updatedAt.toISOString(),
    facts.billing.accountStatus ?? 'none',
    agreements,
  ].join('|')
}

async function liveCounts(database: OperatorDatabase, args: ExecutionArgs) {
  const where = { tenantId: args.tenantId }
  const [venues, memberships, routines, credentials, identities, connectors, reports, grants] =
    await Promise.all([
      database.venue.count({ where: { ...where, isActive: true } }),
      database.tenantMembership.count({
        where: { ...where, status: { in: ['ACTIVE', 'INVITED'] } },
      }),
      database.agentRoutine.count({ where: { ...where, enabled: true } }),
      database.externalAccessCredential.count({ where: { ...where, revokedAt: null } }),
      database.agentIdentity.count({ where: { ...where, enabled: true } }),
      database.liveDataConnector.count({ where: { ...where, state: 'ACTIVE' } }),
      database.venueReportConfiguration.count({ where: { ...where, enabled: true } }),
      database.operatorGrant.count({
        where: { revokedAt: null, allTenants: false, tenantIds: { has: args.tenantId } },
      }),
    ])
  return { venues, memberships, routines, credentials, identities, connectors, reports, grants }
}

export const offboardingExecutionKind: OperatorProposalKind<ExecutionArgs> = {
  kind: 'offboarding.execution',
  tool: 'offboarding.propose_execution',
  capability: 'customers:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ tenantId: args.tenantId }),
  authorize: async (args, context: OperatorKindContext) => {
    if (!isOffboardingExecutionEnabled()) throw disabled()
    const facts = await readFacts(context.database, args)
    try {
      assertOffboardingGate(facts, args.billingHandled)
    } catch (error) {
      refusal(error)
    }
  },
  targetVersion: async (args, context) => versionOf(await readFacts(context.database, args)),
  currentVersion: async (args, context) => versionOf(await readFacts(context.database, args)),
  describe: (args) => ({
    title:
      'Offboard this customer: close its venues, stop its schedules, revoke its access (nothing is deleted)',
    lines: [
      `customer ${args.tenantId}, offboarding plan ${args.planId}`,
      'If GUEST_LINKS or WIDGETS is selected, closes every venue to visitors. Venue availability is shared: guest chat, QR links, and embeds all stop together even if only one of those targets was selected.',
      'Stops routines, report schedules and live-data feeds; revokes integration credentials and operator connections for this customer.',
      'Marks the customer SUSPENDED and local membership records REMOVED. Existing identity-provider sessions may still reach app reads until a person removes their access there.',
      args.billingHandled
        ? `Billing: a person says it is handled (${args.billingNote ?? ''}).`
        : 'Billing: recorded as a checklist item for a person; no payment provider is called.',
      'Identity provider: recorded as a checklist item for a person; nobody is removed there.',
      'Records a manifest of what exists. No data is deleted; retention and deletion are a separate later decision.',
      'Can be reverted to reopen venues and restore local membership records; identity-provider access is manual.',
    ],
  }),
  snapshot: async (args, context) => {
    const facts = await readFacts(context.database, args)
    return {
      planStatus: facts.plan.status,
      tenantStatus: facts.tenantStatus,
      ...(await liveCounts(context.database, args)),
    } as unknown as JsonValue
  },
  pendingChanges: async (args, database) => {
    const now = await liveCounts(database, args)
    return [
      { field: 'venues open to visitors', before: String(now.venues), after: '0' },
      {
        field: 'active or invited local membership records',
        before: String(now.memberships),
        after: '0',
      },
      { field: 'enabled routines', before: String(now.routines), after: '0' },
      { field: 'enabled report schedules', before: String(now.reports), after: '0' },
      { field: 'active live-data feeds', before: String(now.connectors), after: '0' },
      { field: 'active integration credentials', before: String(now.credentials), after: '0' },
      { field: 'enabled agent identities', before: String(now.identities), after: '0' },
      { field: 'operator connections for this customer', before: String(now.grants), after: '0' },
      { field: 'customer status', before: 'as now', after: 'SUSPENDED' },
    ]
  },
  apply: async (args, context: OperatorApplyContext) => {
    // Checked again: the switch may have been turned off between approval and dispatch.
    if (!isOffboardingExecutionEnabled()) throw disabled()
    return executeOffboardingPlan(args, context, hooks)
  },
  /** The execution row is the receipt: it names the last operation that worked on the plan. */
  reconcile: async (args, context) => {
    const execution = await readOffboardingExecutionAction(
      { tenantId: args.tenantId, planId: args.planId },
      context.database,
    )
    if (!execution || execution.lastOperationId !== context.operationId) {
      return { state: 'not_applied' }
    }
    if (execution.status === 'COMPLETED') {
      return { state: 'applied', outcome: offboardingOutcome(execution, true) }
    }
    return { state: 'unknown' }
  },
  resolveUnknown: async (args, context): Promise<OperatorUnknownResolution> => {
    const execution = await readOffboardingExecutionAction(
      { tenantId: args.tenantId, planId: args.planId },
      context.database,
    )
    if (!execution || execution.lastOperationId !== context.operationId) {
      return {
        state: 'no_effect',
        summary: 'Offboarding did not start under this operation; nothing was changed by it.',
      }
    }
    if (execution.status === 'COMPLETED') {
      return { state: 'applied', outcome: offboardingOutcome(execution, true) }
    }
    const settled = execution.steps.filter(
      (step) => step.status !== 'PENDING' && step.status !== 'FAILED',
    )
    if (settled.length === 0) {
      return {
        state: 'unknown',
        summary:
          'Offboarding started but no step settled. The first step may have changed data; inspect the execution before retrying.',
      }
    }
    return {
      state: 'partially_applied',
      summary: OFFBOARDING_SUMMARY.partial,
      result: {
        executionId: execution.id,
        steps: execution.steps.map((step) => ({
          step: step.key,
          status: step.status,
        })) as JsonValue,
      },
    }
  },
  /** Reopens the venues and restores local membership records; provider access remains manual. */
  revert: async (original: StoredOperatorProposal, context: OperatorApplyContext) => {
    try {
      return await reinstateOffboardingExecution(original, context)
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'NOT_FOUND') throw new OperatorNotFoundError()
      if (code === 'STALE') throw new OperatorStaleError((error as Error).message)
      throw error
    }
  },
}

export const OFFBOARDING_KINDS = [offboardingExecutionKind]
