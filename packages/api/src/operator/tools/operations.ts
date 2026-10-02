import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { OperatorNotFoundError } from '../grants'
import { claimIsStale } from '../execution'
import { planEffect, proposalEffect } from '../outcome'
import { planView } from '../plans'
import { proposalView, type OperatorWriteView } from '../proposals'
import type { OperatorCallContext, OperatorReadTool } from '../registry'
import { pageResult, requireCursorInScope } from './page'

const PAGE_SIZE = 25

type ProposalRow = NonNullable<
  Awaited<ReturnType<OperatorCallContext['database']['operatorProposal']['findUnique']>>
>
type PlanRow = NonNullable<
  Awaited<ReturnType<OperatorCallContext['database']['operatorPlan']['findUnique']>>
>

const iso = (value: Date | null) => (value ? value.toISOString() : null)

type ExecutionState =
  | 'awaiting_approval'
  | 'queued'
  | 'running'
  | 'needs_recovery'
  | 'finished'
  | 'closed'

/** Where the work is, from recorded state only. */
function executionOf(
  row: Readonly<{
    status: string
    applyClaimedAt: Date | null
    leaseExpiresAt: Date | null
    attempt: number
  }>,
  now: Date,
) {
  let state: ExecutionState
  if (row.status === 'PENDING') state = 'awaiting_approval'
  else if (row.status === 'APPROVED') {
    state =
      row.applyClaimedAt === null ? 'queued' : claimIsStale(row, now) ? 'needs_recovery' : 'running'
  } else if (row.status === 'APPLIED' || row.status === 'FAILED') state = 'finished'
  else state = 'closed'
  return { state, attempt: row.attempt, leaseExpiresAt: iso(row.leaseExpiresAt) }
}

const NEXT_ACTION_BY_FAILURE: Readonly<Record<string, string>> = {
  OUTCOME_UNKNOWN:
    'The outcome is unconfirmed. Call operator.recover_operation with this operationId to reconcile it. Do not send a new operationId for the same change until it reports a settled state.',
  PARTIALLY_APPLIED:
    'Part of the change took effect. Do not propose it again; a person must review and finish the remainder.',
  FAILED_NO_EFFECT:
    'Nothing was changed. It is safe to propose the change again with a new operationId.',
}

function summaryOf(result: unknown): string | undefined {
  const summary =
    result && typeof result === 'object' ? (result as { summary?: unknown }).summary : undefined
  return typeof summary === 'string' && summary.length > 0 ? summary.slice(0, 500) : undefined
}

/** One proposal as the operator reads it back: status plus what is known about its effect. */
export function proposalOperationView(row: ProposalRow, context: OperatorCallContext) {
  return {
    ...proposalView(row, context.config),
    operationId: row.operationId,
    tool: row.tool,
    kind: row.kind,
    effect: proposalEffect(row),
    execution: executionOf(row, context.now),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: iso(row.decidedAt),
    appliedAt: iso(row.appliedAt),
    authorizedBy:
      row.decidedAt === null ? null : row.autoApproved ? ('policy' as const) : ('human' as const),
    initiatedByClientId: row.clientId,
    planId: row.planId,
    planStepIndex: row.planStepIndex,
    failureCode: row.failureCode,
    ...(summaryOf(row.result) ? { summary: summaryOf(row.result)! } : {}),
    ...(row.status === 'FAILED' && row.failureCode && NEXT_ACTION_BY_FAILURE[row.failureCode]
      ? { nextAction: NEXT_ACTION_BY_FAILURE[row.failureCode]! }
      : {}),
  }
}

/** A plan's effect comes from its steps, so an early applied step is never hidden by a failure. */
export async function planOperationView(plan: PlanRow, context: OperatorCallContext) {
  const steps = await context.database.operatorProposal.findMany({
    where: { planId: plan.id },
    select: {
      status: true,
      applyClaimedAt: true,
      applyStartedAt: true,
      attempt: true,
      failureCode: true,
      autoApproved: true,
    },
  })
  const base: OperatorWriteView = await planView(plan, context)
  return {
    ...base,
    operationId: plan.operationId,
    tool: 'operator.propose_plan',
    kind: 'operator.plan',
    effect: planEffect(steps),
    execution: executionOf(plan, context.now),
    createdAt: plan.createdAt.toISOString(),
    expiresAt: plan.expiresAt.toISOString(),
    decidedAt: iso(plan.decidedAt),
    appliedAt: null,
    authorizedBy:
      plan.decidedAt === null
        ? null
        : steps.some((step) => step.autoApproved)
          ? ('policy' as const)
          : ('human' as const),
    initiatedByClientId: plan.clientId,
    planId: null,
    planStepIndex: null,
    failureCode: null,
  }
}

/** A proposal or plan owned by this connection; anything else is indistinguishable from absent. */
export async function findOwnedOperation(id: string, context: OperatorCallContext) {
  const plan = await context.database.operatorPlan.findUnique({ where: { id } })
  if (plan) {
    if (plan.grantId !== context.grant.grantId) throw new OperatorNotFoundError()
    return planOperationView(plan, context)
  }
  const row = await context.database.operatorProposal.findUnique({ where: { id } })
  if (!row || row.grantId !== context.grant.grantId) throw new OperatorNotFoundError()
  return proposalOperationView(row, context)
}

const getOperation: OperatorReadTool = {
  name: 'operator.get_operation',
  capability: 'operator:read',
  async handler(raw, context) {
    const { originalOperationId } = OPERATOR_MCP_INPUTS['operator.get_operation'].parse(raw)
    const grantId = context.grant.grantId
    // operationId is unique per connection, so a retry or a new session can recover the record.
    const plan = await context.database.operatorPlan.findUnique({
      where: { grantId_operationId: { grantId, operationId: originalOperationId } },
    })
    if (plan) return planOperationView(plan, context)
    const row = await context.database.operatorProposal.findUnique({
      where: { grantId_operationId: { grantId, operationId: originalOperationId } },
    })
    if (!row) throw new OperatorNotFoundError()
    return proposalOperationView(row, context)
  },
}

const listPlans: OperatorReadTool = {
  name: 'operator.list_plans',
  capability: 'operator:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['operator.list_plans'].parse(raw)
    const size = Math.min(input.limit, PAGE_SIZE)
    const where = {
      grantId: context.grant.grantId,
      ...(input.status ? { status: input.status } : {}),
    }
    await requireCursorInScope(input.cursor, (id) =>
      context.database.operatorPlan.findFirst({
        where: { ...where, id },
        select: { id: true },
      }),
    )
    const rows = await context.database.operatorPlan.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    })
    const page = rows.slice(0, size)
    const items = []
    for (const plan of page) items.push(await planOperationView(plan, context))
    return pageResult(items, rows.length > size ? page.at(-1)!.id : null)
  },
}

export const operationReadTools: readonly OperatorReadTool[] = [getOperation, listPlans]
