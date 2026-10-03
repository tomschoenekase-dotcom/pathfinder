import { db } from '@pathfinder/db'

import { writeOperatorAudit, type OperatorDatabase } from './audit'
import { drivePlan, resolveStepReferences } from './plans'
import {
  applyApprovedProposal,
  finish,
  kindByName,
  loadGrant,
  OPERATOR_APPLY_LEASE_MS,
  OPERATOR_FAILED_NO_EFFECT,
  OPERATOR_OUTCOME_UNKNOWN,
  OPERATOR_PARTIALLY_APPLIED,
  type OperatorApplyContext,
  type OperatorDecisionDependencies,
  type OperatorUnknownResolution,
} from './proposals'

type ProposalRow = NonNullable<
  Awaited<ReturnType<OperatorDatabase['operatorProposal']['findUnique']>>
>
type PlanRow = NonNullable<Awaited<ReturnType<OperatorDatabase['operatorPlan']['findUnique']>>>

type RecoveryInput = Readonly<{ requestId: string; now: Date }>

/**
 * A claim whose lease ran out. Rows claimed before leases existed have no expiry, so they are
 * judged by the claim time against the same lease length.
 */
export function claimIsStale(
  row: Readonly<{ applyClaimedAt: Date | null; leaseExpiresAt: Date | null }>,
  now: Date,
): boolean {
  if (row.applyClaimedAt === null) return false
  const expires =
    row.leaseExpiresAt ?? new Date(row.applyClaimedAt.getTime() + OPERATOR_APPLY_LEASE_MS)
  return expires <= now
}

async function audit(
  database: OperatorDatabase,
  row: Pick<ProposalRow, 'id' | 'grantId' | 'clientId' | 'tool' | 'argsHash' | 'planId'>,
  requestId: string,
  outcome: string,
) {
  await writeOperatorAudit(
    {
      requestId,
      eventType: 'proposal.recovery',
      outcome,
      grantId: row.grantId,
      clientId: row.clientId,
      tool: row.tool,
      argsHash: row.argsHash,
      proposalId: row.id,
      planId: row.planId,
    },
    database,
  )
}

async function priorStepResults(database: OperatorDatabase, row: ProposalRow) {
  const results = new Map<number, Record<string, unknown>>()
  if (row.planId === null) return results
  const earlier = await database.operatorProposal.findMany({
    where: { planId: row.planId, status: 'APPLIED' },
    select: { planStepIndex: true, result: true },
  })
  for (const step of earlier) {
    if (step.planStepIndex !== null) {
      results.set(step.planStepIndex, (step.result ?? {}) as Record<string, unknown>)
    }
  }
  return results
}

/**
 * Resolves one proposal whose apply claim went stale. It never retries blindly:
 *  - never reached its domain write  -> the claim is released, so it can be applied again;
 *  - provably took effect            -> recorded as applied, with the receipt that proves it;
 *  - provably did not take effect    -> released for a safe retry;
 *  - cannot be determined            -> held as OUTCOME_UNKNOWN for a human, never retried.
 */
export async function reconcileProposal(
  proposalId: string,
  dependencies: OperatorDecisionDependencies,
  input: RecoveryInput,
): Promise<ProposalRow> {
  const database = dependencies.database ?? db
  const current = await database.operatorProposal.findUnique({ where: { id: proposalId } })
  if (!current) throw new Error('Proposal not found')
  if (current.status !== 'APPROVED' || !claimIsStale(current, input.now)) return current
  // Take the lease over under a new fence, so the worker that stalled can no longer record a result.
  const taken = await database.operatorProposal.updateMany({
    where: { id: current.id, status: 'APPROVED', fenceToken: current.fenceToken },
    data: {
      fenceToken: { increment: 1 },
      leaseExpiresAt: new Date(input.now.getTime() + OPERATOR_APPLY_LEASE_MS),
    },
  })
  if (taken.count !== 1) {
    return (await database.operatorProposal.findUnique({ where: { id: proposalId } }))!
  }
  const row = (await database.operatorProposal.findUnique({ where: { id: proposalId } }))!
  const release = async (outcome: string) => {
    await database.operatorProposal.updateMany({
      where: { id: row.id, status: 'APPROVED', fenceToken: row.fenceToken },
      data: { applyClaimedAt: null, applyStartedAt: null, leaseExpiresAt: null },
    })
    await audit(database, row, input.requestId, outcome)
    return (await database.operatorProposal.findUnique({ where: { id: row.id } }))!
  }
  const neverStarted = row.attempt > 0 && row.applyStartedAt === null
  if (neverStarted) return release('RELEASED_NEVER_STARTED')

  const approver = row.decidedByUserId ?? ''
  const grant = await loadGrant(database, row.grantId, input.now, dependencies.allowedUserIds)
  const kind = kindByName(dependencies.kinds, row.kind)
  const unknown = async () => {
    await audit(database, row, input.requestId, 'OUTCOME_UNKNOWN')
    return finish(
      database,
      row,
      'FAILED',
      { failureCode: 'OUTCOME_UNKNOWN' },
      input.requestId,
      approver,
    )
  }
  if (!grant || !kind?.reconcile) return unknown()
  const context: OperatorApplyContext = {
    database,
    grant,
    now: input.now,
    actor: { type: 'HUMAN', id: approver, role: 'PLATFORM_ADMIN' },
    proposalId: row.id,
    operationId: row.operationId,
  }
  try {
    const stepResults = await priorStepResults(database, row)
    const args = kind.parse(resolveStepReferences(row.args, stepResults))
    const verdict = await kind.reconcile(args, context)
    if (verdict.state === 'applied') {
      await audit(database, row, input.requestId, 'RECONCILED_APPLIED')
      return finish(
        database,
        row,
        'APPLIED',
        {
          result: { ...verdict.outcome.result, reconciled: true },
          afterSnapshot: verdict.outcome.after,
          appliedAt: row.applyStartedAt ?? input.now,
        },
        input.requestId,
        approver,
      )
    }
    if (verdict.state === 'not_applied') return release('RELEASED_NOT_APPLIED')
  } catch {
    // A reconciler that cannot decide is treated as undecided, never as "not applied".
  }
  return unknown()
}

const RESOLVABLE_FAILURES: ReadonlySet<string> = new Set([
  OPERATOR_OUTCOME_UNKNOWN,
  OPERATOR_PARTIALLY_APPLIED,
])

/**
 * Settles an operation recorded as OUTCOME_UNKNOWN (or re-checks a PARTIALLY_APPLIED one) by
 * asking its kind to look, read-only, at canonical and provider state. It never repeats an effect:
 *  - provably complete    -> APPLIED, with the receipt that proves it;
 *  - some steps took hold -> FAILED / PARTIALLY_APPLIED, with a plain-language account of which;
 *  - nothing took hold    -> FAILED / FAILED_NO_EFFECT, which proves a new operation is safe;
 *  - cannot be told       -> left OUTCOME_UNKNOWN for a person.
 * Concurrent resolvers are serialised by the fence token.
 */
export async function resolveUnknownProposal(
  proposalId: string,
  dependencies: OperatorDecisionDependencies,
  input: RecoveryInput,
): Promise<ProposalRow> {
  const database = dependencies.database ?? db
  const current = await database.operatorProposal.findUnique({ where: { id: proposalId } })
  if (!current) throw new Error('Proposal not found')
  if (
    current.status !== 'FAILED' ||
    current.planId !== null ||
    !RESOLVABLE_FAILURES.has(current.failureCode ?? '')
  ) {
    return current
  }
  const kind = kindByName(dependencies.kinds, current.kind)
  if (!kind?.resolveUnknown) return current
  const taken = await database.operatorProposal.updateMany({
    where: {
      id: current.id,
      status: 'FAILED',
      failureCode: current.failureCode,
      fenceToken: current.fenceToken,
    },
    data: { fenceToken: { increment: 1 } },
  })
  const reread = async () =>
    (await database.operatorProposal.findUnique({ where: { id: proposalId } }))!
  if (taken.count !== 1) return reread()
  const row = await reread()
  const approver = row.decidedByUserId ?? ''
  const grant = await loadGrant(database, row.grantId, input.now, dependencies.allowedUserIds)
  let verdict: OperatorUnknownResolution = { state: 'unknown' }
  if (grant) {
    const context: OperatorApplyContext = {
      database,
      grant,
      now: input.now,
      actor: { type: 'HUMAN', id: approver, role: 'PLATFORM_ADMIN' },
      proposalId: row.id,
      operationId: row.operationId,
    }
    try {
      verdict = await kind.resolveUnknown(kind.parse(row.args), context)
    } catch {
      // A resolver that cannot decide is undecided, never "no effect".
    }
  }
  const fenced = { id: row.id, status: 'FAILED' as const, fenceToken: row.fenceToken }
  if (verdict.state === 'applied') {
    await database.operatorProposal.updateMany({
      where: fenced,
      data: {
        status: 'APPLIED',
        failureCode: null,
        result: { ...verdict.outcome.result, reconciled: true } as object,
        afterSnapshot: verdict.outcome.after as object,
        appliedAt: row.applyStartedAt ?? input.now,
        leaseExpiresAt: null,
      },
    })
    await audit(database, row, input.requestId, 'RESOLVED_APPLIED')
  } else if (verdict.state === 'partially_applied') {
    await database.operatorProposal.updateMany({
      where: fenced,
      data: {
        failureCode: OPERATOR_PARTIALLY_APPLIED,
        result: { ...verdict.result, summary: verdict.summary, reconciled: true } as object,
      },
    })
    await audit(database, row, input.requestId, 'RESOLVED_PARTIALLY_APPLIED')
  } else if (verdict.state === 'no_effect') {
    await database.operatorProposal.updateMany({
      where: fenced,
      data: {
        failureCode: OPERATOR_FAILED_NO_EFFECT,
        applyStartedAt: null,
        result: { summary: verdict.summary, reconciled: true } as object,
      },
    })
    await audit(database, row, input.requestId, 'RESOLVED_NO_EFFECT')
  } else {
    await audit(database, row, input.requestId, 'RESOLVE_STILL_UNKNOWN')
  }
  return reread()
}

/**
 * Brings an interrupted operation forward without ever repeating an effect. For a standalone
 * proposal that is reconcile-then-reapply when the apply never began. For a plan it takes over the
 * plan lease, reconciles any stalled step, and continues from the first unapplied step.
 */
export async function recoverOperation(
  id: string,
  dependencies: OperatorDecisionDependencies,
  input: RecoveryInput,
): Promise<void> {
  const database = dependencies.database ?? db
  const plan = await database.operatorPlan.findUnique({ where: { id } })
  if (plan) return recoverPlan(plan, dependencies, input)
  const row = await database.operatorProposal.findUnique({ where: { id } })
  if (!row || row.planId !== null) return
  if (row.status === 'FAILED') {
    await resolveUnknownProposal(row.id, dependencies, input)
    return
  }
  if (row.status !== 'APPROVED') return
  const settled = await reconcileProposal(row.id, dependencies, input)
  if (settled.status === 'FAILED') {
    await resolveUnknownProposal(settled.id, dependencies, input)
    return
  }
  // Released with no effect, or approved and never claimed: apply it now under the original approval.
  if (settled.status === 'APPROVED' && settled.applyClaimedAt === null) {
    await applyApprovedProposal(
      settled.id,
      { actorUserId: settled.decidedByUserId ?? '', requestId: input.requestId, now: input.now },
      dependencies,
    )
  }
}

async function recoverPlan(
  plan: PlanRow,
  dependencies: OperatorDecisionDependencies,
  input: RecoveryInput,
): Promise<void> {
  const database = dependencies.database ?? db
  if (plan.status !== 'APPROVED' || !claimIsStale(plan, input.now)) return
  const taken = await database.operatorPlan.updateMany({
    where: { id: plan.id, status: 'APPROVED', fenceToken: plan.fenceToken },
    data: {
      fenceToken: { increment: 1 },
      attempt: { increment: 1 },
      leaseExpiresAt: new Date(input.now.getTime() + OPERATOR_APPLY_LEASE_MS),
    },
  })
  if (taken.count !== 1) return
  const owned = (await database.operatorPlan.findUnique({ where: { id: plan.id } }))!
  const steps = await database.operatorProposal.findMany({
    where: { planId: plan.id, status: 'APPROVED', applyClaimedAt: { not: null } },
    select: { id: true },
  })
  for (const step of steps) await reconcileProposal(step.id, dependencies, input)
  await drivePlan(
    owned,
    { actorUserId: owned.decidedByUserId ?? '', requestId: input.requestId, now: input.now },
    dependencies,
  )
}
