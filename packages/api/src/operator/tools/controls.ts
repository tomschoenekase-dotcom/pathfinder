import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { writeOperatorAudit } from '../audit'
import { claimIsStale, recoverOperation } from '../execution'
import { OperatorNotFoundError } from '../grants'
import { OperatorProposalError } from '../proposals'
import type { OperatorCallContext, OperatorReadTool } from '../registry'
import { planOperationView, proposalOperationView } from './operations'

type OwnedOperation =
  | { kind: 'plan'; id: string }
  | { kind: 'proposal'; id: string; planId: string | null }

/** The connection's own operation by the operationId it originally sent; others look absent. */
async function findByOperationId(
  originalOperationId: string,
  context: OperatorCallContext,
): Promise<OwnedOperation> {
  const key = {
    grantId_operationId: { grantId: context.grant.grantId, operationId: originalOperationId },
  }
  const plan = await context.database.operatorPlan.findUnique({ where: key })
  if (plan) return { kind: 'plan', id: plan.id }
  const proposal = await context.database.operatorProposal.findUnique({ where: key })
  if (!proposal) throw new OperatorNotFoundError()
  return { kind: 'proposal', id: proposal.id, planId: proposal.planId }
}

async function viewOf(operation: OwnedOperation, context: OperatorCallContext) {
  if (operation.kind === 'plan') {
    const plan = await context.database.operatorPlan.findUniqueOrThrow({
      where: { id: operation.id },
    })
    return planOperationView(plan, context)
  }
  const row = await context.database.operatorProposal.findUniqueOrThrow({
    where: { id: operation.id },
  })
  return proposalOperationView(row, context)
}

async function auditControl(
  context: OperatorCallContext,
  outcome: string,
  ids: { proposalId?: string; planId?: string },
) {
  await writeOperatorAudit(
    {
      requestId: context.requestId,
      eventType: 'proposal.transition',
      outcome,
      grantId: context.grant.grantId,
      clientId: context.grant.clientId,
      tool: 'operator.control',
      proposalId: ids.proposalId ?? null,
      planId: ids.planId ?? null,
      actorUserId: null,
    },
    context.database,
  )
}

const notCancellable = (message: string) => new OperatorProposalError('NOT_CANCELLABLE', message)

/**
 * Withdraws work that has not begun. Cancelling stops future steps; it never undoes an applied
 * one, and it refuses anything running so a cancel cannot race an in-flight effect.
 */
const cancelOperation: OperatorReadTool = {
  name: 'operator.cancel_operation',
  capability: 'operator:plan',
  async handler(raw, context) {
    const { originalOperationId } = OPERATOR_MCP_INPUTS['operator.cancel_operation'].parse(raw)
    const operation = await findByOperationId(originalOperationId, context)
    const database = context.database
    if (operation.kind === 'proposal') {
      if (operation.planId !== null) {
        throw notCancellable('This step belongs to a plan. Cancel the plan instead.')
      }
      const closed = await database.operatorProposal.updateMany({
        where: {
          id: operation.id,
          OR: [{ status: 'PENDING' }, { status: 'APPROVED', applyClaimedAt: null }],
        },
        data: { status: 'REJECTED', failureCode: 'CANCELLED' },
      })
      if (closed.count === 1) await auditControl(context, 'CANCELLED', { proposalId: operation.id })
      else {
        const current = await database.operatorProposal.findUniqueOrThrow({
          where: { id: operation.id },
        })
        // Already cancelled is a successful no-op; anything else has begun or finished.
        if (current.failureCode !== 'CANCELLED') {
          throw notCancellable(
            'This operation has already started or finished and cannot be cancelled.',
          )
        }
      }
      return viewOf(operation, context)
    }

    const plan = await database.operatorPlan.findUniqueOrThrow({ where: { id: operation.id } })
    if (plan.status === 'PENDING') {
      const closed = await database.operatorPlan.updateMany({
        where: { id: plan.id, status: 'PENDING' },
        data: { status: 'REJECTED' },
      })
      if (closed.count === 1) {
        await database.operatorProposal.updateMany({
          where: { planId: plan.id, status: 'PENDING' },
          data: { status: 'REJECTED', failureCode: 'CANCELLED' },
        })
        await auditControl(context, 'CANCELLED', { planId: plan.id })
      }
      return viewOf(operation, context)
    }
    if (plan.status === 'APPROVED') {
      const claimed = await database.operatorProposal.findMany({
        where: { planId: plan.id, status: 'APPROVED', applyClaimedAt: { not: null } },
        select: { applyClaimedAt: true, leaseExpiresAt: true },
      })
      if (claimed.some((step) => !claimIsStale(step, context.now))) {
        throw notCancellable('A step of this plan is running. Wait for it, then cancel or recover.')
      }
      // Remaining unstarted steps are closed; the plan keeps the truth about what already applied.
      const remaining = await database.operatorProposal.findMany({
        where: { planId: plan.id, status: 'APPROVED', applyClaimedAt: null },
        orderBy: { planStepIndex: 'asc' },
        select: { id: true, planStepIndex: true },
      })
      if (remaining.length > 0) {
        await database.operatorProposal.updateMany({
          where: { id: { in: remaining.map((step) => step.id) }, status: 'APPROVED' },
          data: { status: 'REJECTED', failureCode: 'CANCELLED' },
        })
        const closed = await database.operatorPlan.updateMany({
          where: { id: plan.id, status: 'APPROVED', fenceToken: plan.fenceToken },
          data: {
            status: 'FAILED',
            failedStepIndex: remaining[0]!.planStepIndex,
            leaseExpiresAt: null,
            fenceToken: { increment: 1 },
          },
        })
        if (closed.count === 1) await auditControl(context, 'CANCELLED', { planId: plan.id })
      }
      return viewOf(operation, context)
    }
    if (plan.status === 'REJECTED') return viewOf(operation, context)
    throw notCancellable('This plan has already finished and cannot be cancelled.')
  },
}

/** Continues an already-approved operation after an interruption. It cannot approve anything. */
const recoverOperationTool: OperatorReadTool = {
  name: 'operator.recover_operation',
  capability: 'operator:plan',
  async handler(raw, context) {
    const { originalOperationId } = OPERATOR_MCP_INPUTS['operator.recover_operation'].parse(raw)
    const operation = await findByOperationId(originalOperationId, context)
    // Steps of a plan are recovered through their plan.
    const target =
      operation.kind === 'proposal' && operation.planId ? operation.planId : operation.id
    await recoverOperation(
      target,
      {
        database: context.database,
        kinds: context.kinds,
        allowedUserIds: context.config.allowedUserIds,
      },
      { requestId: context.requestId, now: context.now },
    )
    await auditControl(context, 'RECOVER_REQUESTED', {
      ...(operation.kind === 'plan' ? { planId: operation.id } : { proposalId: operation.id }),
    })
    return viewOf(operation, context)
  },
}

export const controlTools: readonly OperatorReadTool[] = [cancelOperation, recoverOperationTool]
