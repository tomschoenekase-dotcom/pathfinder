import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { db } from '@pathfinder/db'

import { writeOperatorAudit, type OperatorDatabase } from './audit'
import { admitAutoApply } from './admission'
import { isRoutineAutoKind, readPolicyRevision, resolveAutonomy } from './autonomy'
import { OPERATOR_OAUTH_LIFETIMES, approveUrl } from './config'
import { OperatorDeploymentDisabledError } from './deployment-prerequisite'
import { assertGrantCapability, assertTenantInGrant, OperatorNotFoundError } from './grants'
import {
  applyApprovedProposal,
  derivedOperationId,
  OPERATOR_APPLY_LEASE_MS,
  previewDigestOf,
  OperatorProposalError,
  type OperatorDecisionDependencies,
  type AnyOperatorProposalKind,
  type OperatorServiceContext,
  type OperatorWriteView,
} from './proposals'
import { argsHash as hashArgs, sameHash } from './tokens'

export type OperatorPlanInput = Readonly<{
  operationId: string
  title: string
  steps: ReadonlyArray<
    Readonly<{
      tool: string
      arguments: Record<string, unknown>
      dependsOn?: readonly number[] | undefined
    }>
  >
}>

const REFERENCE = /^\{\{steps\.(\d{1,2})\.result\.([A-Za-z][A-Za-z0-9_]{0,63})\}\}$/u

function references(value: unknown, found: Array<{ step: number; field: string }> = []) {
  if (typeof value === 'string') {
    const match = REFERENCE.exec(value)
    if (match) found.push({ step: Number(match[1]), field: match[2]! })
    else if (value.includes('{{'))
      throw new OperatorProposalError('PLAN_STEP', 'Malformed step reference.')
  } else if (Array.isArray(value)) {
    for (const item of value) references(item, found)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) references(item, found)
  }
  return found
}

/** Replaces whole-string references with earlier step results. Only strings and numbers flow. */
export function resolveStepReferences(
  value: unknown,
  results: ReadonlyMap<number, Record<string, unknown>>,
): unknown {
  if (typeof value === 'string') {
    const match = REFERENCE.exec(value)
    if (!match) return value
    const resolved = results.get(Number(match[1]))?.[match[2]!]
    if (typeof resolved !== 'string' && typeof resolved !== 'number') {
      throw new OperatorProposalError('PLAN_STEP', 'A step reference did not resolve.')
    }
    return resolved
  }
  if (Array.isArray(value)) return value.map((item) => resolveStepReferences(item, results))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveStepReferences(item, results)]),
    )
  }
  return value
}

/**
 * One approval for an ordered job. Each step is stored as a PENDING proposal bound to the plan;
 * the plan's argsHash covers the title and every step exactly as proposed.
 */
export async function createPlan(
  input: OperatorPlanInput,
  service: OperatorServiceContext,
): Promise<OperatorWriteView> {
  const database = service.database ?? db
  assertGrantCapability(service.grant, 'operator:plan')
  const argsHash = hashArgs({
    tool: 'operator.propose_plan',
    args: { title: input.title, steps: input.steps },
  })
  const existing = await database.operatorPlan.findUnique({
    where: {
      grantId_operationId: { grantId: service.grant.grantId, operationId: input.operationId },
    },
  })
  if (existing) {
    if (!sameHash(existing.argsHash, argsHash)) {
      throw new OperatorProposalError(
        'OPERATION_ID_REUSED',
        'This operationId was already used for a different plan.',
      )
    }
    return planView(existing, service)
  }
  const context = { database, grant: service.grant, now: service.now }
  const prepared: Array<{
    index: number
    kind: AnyOperatorProposalKind
    raw: Record<string, unknown> & { operationId: string }
    operationId: string
    targetVersion: string | null
    previewDigest: string | null
    tenantId: unknown
  }> = []
  for (const [index, step] of input.steps.entries()) {
    const kind = service.kinds.get(step.tool)
    if (!kind)
      throw new OperatorProposalError('UNKNOWN_KIND', `Step ${index} names an unknown tool.`)
    assertGrantCapability(service.grant, kind.capability)
    const refs = references(step.arguments)
    if (refs.some((ref) => ref.step >= index)) {
      throw new OperatorProposalError('PLAN_STEP', 'Steps may only reference earlier steps.')
    }
    const operationId = derivedOperationId(input.operationId, index)
    const raw = { ...step.arguments, operationId }
    const tenantId = (step.arguments as { tenantId?: unknown }).tenantId
    if (typeof tenantId === 'string' && REFERENCE.test(tenantId)) {
      throw new OperatorProposalError(
        'PLAN_STEP',
        'tenantId must be literal so scope is checked now.',
      )
    }
    let targetVersion: string | null = null
    let previewDigest: string | null = null
    if (refs.length === 0) {
      const args = kind.parse(raw)
      const target = kind.target(args)
      if (target.tenantId !== undefined)
        await assertTenantInGrant(service.grant, target.tenantId, database)
      try {
        await kind.authorize?.(args, context)
      } catch (error) {
        if (error instanceof OperatorDeploymentDisabledError) {
          error.operationRecorded = false
          error.details.stepIndex = index
          error.details.stepTool = step.tool
        }
        throw error
      }
      targetVersion = await kind.targetVersion(args, context)
      // Steps that reference earlier results cannot be previewed now, so they carry no digest.
      previewDigest = previewDigestOf(kind, args, targetVersion)
    } else if (typeof tenantId === 'string') {
      await assertTenantInGrant(service.grant, tenantId, database)
    }
    prepared.push({ index, kind, raw, operationId, targetVersion, previewDigest, tenantId })
  }
  const expiresAt = new Date(
    service.now.getTime() + OPERATOR_OAUTH_LIFETIMES.proposalHours * 3_600_000,
  )
  const policyRevision = await readPolicyRevision(database)
  const plan = await database.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as OperatorDatabase
    const created = await tx.operatorPlan.create({
      data: {
        grantId: service.grant.grantId,
        clientId: service.grant.clientId,
        operationId: input.operationId,
        title: input.title,
        argsHash,
        expiresAt,
        createdAt: service.now,
      },
    })
    for (const step of prepared) {
      await tx.operatorProposal.create({
        data: {
          grantId: service.grant.grantId,
          clientId: service.grant.clientId,
          operationId: step.operationId,
          kind: step.kind.kind,
          tool: step.kind.tool,
          capability: step.kind.capability,
          targetTenantId: typeof step.tenantId === 'string' ? step.tenantId : null,
          targetVenueId:
            typeof step.raw.venueId === 'string' && !REFERENCE.test(step.raw.venueId)
              ? step.raw.venueId
              : null,
          args: step.raw as object,
          argsHash: hashArgs({ tool: step.kind.tool, args: step.raw }),
          targetVersion: step.targetVersion,
          previewDigest: step.previewDigest,
          policyRevision,
          planId: created.id,
          planStepIndex: step.index,
          expiresAt,
          createdAt: service.now,
        },
      })
    }
    await writeOperatorAudit(
      {
        requestId: service.requestId,
        eventType: 'plan.transition',
        outcome: 'CREATED',
        grantId: service.grant.grantId,
        clientId: service.grant.clientId,
        tool: 'operator.propose_plan',
        argsHash,
        planId: created.id,
        args: { title: input.title, steps: input.steps.map((step) => step.tool) },
      },
      tx,
    )
    return created
  })
  const modes = await Promise.all(prepared.map((step) => resolveAutonomy(step.kind, database)))
  // Plans made entirely of routine actions use transport throttling, without an approval quota.
  const planBudget =
    modes.every((mode) => mode === 'auto') &&
    (prepared.every((step) => isRoutineAutoKind(step.kind.kind)) ||
      (await admitAutoApply(database, service.grant.grantId, service.now)).allowed)
  if (planBudget) {
    await approveAndApplyPlan(
      {
        planId: plan.id,
        argsHash,
        actorUserId: service.grant.userId,
        auto: true,
        requestId: service.requestId,
        now: service.now,
      },
      { database, kinds: service.kinds, allowedUserIds: service.config.allowedUserIds },
    )
  }
  return planView((await database.operatorPlan.findUnique({ where: { id: plan.id } }))!, service)
}

type PlanRow = NonNullable<Awaited<ReturnType<OperatorDatabase['operatorPlan']['findUnique']>>>

async function planView(
  plan: PlanRow,
  service: Pick<OperatorServiceContext, 'config' | 'database'>,
): Promise<OperatorWriteView> {
  const database = service.database ?? db
  const steps = await database.operatorProposal.findMany({
    where: { planId: plan.id },
    orderBy: { planStepIndex: 'asc' },
    select: {
      planStepIndex: true,
      tool: true,
      status: true,
      result: true,
      failureCode: true,
      id: true,
    },
  })
  return {
    proposalId: plan.id,
    status: plan.status,
    argsHash: plan.argsHash,
    ...(plan.status === 'PENDING' ? { approveUrl: approveUrl(service.config, plan.id) } : {}),
    result: {
      steps: steps.map((step) => ({
        index: step.planStepIndex,
        proposalId: step.id,
        tool: step.tool,
        status: step.status,
        ...(step.status === 'APPLIED' ? { result: step.result as JsonValue } : {}),
        ...(step.failureCode ? { failureCode: step.failureCode } : {}),
      })),
    },
  }
}

export { planView }

type PlanDecision = Readonly<{
  planId: string
  argsHash: string
  actorUserId: string
  requestId: string
  now: Date
  auto?: boolean
}>

async function auditPlan(
  database: OperatorDatabase,
  plan: PlanRow,
  requestId: string,
  outcome: string,
  actorUserId: string | null,
) {
  await writeOperatorAudit(
    {
      requestId,
      eventType: 'plan.transition',
      outcome,
      grantId: plan.grantId,
      clientId: plan.clientId,
      tool: 'operator.propose_plan',
      argsHash: plan.argsHash,
      planId: plan.id,
      actorUserId,
    },
    database,
  )
}

/** Approves a plan once, then applies its steps in order and stops at the first failure. */
export async function approveAndApplyPlan(
  input: PlanDecision,
  dependencies: OperatorDecisionDependencies,
): Promise<PlanRow> {
  const database = dependencies.database ?? db
  const plan = await database.operatorPlan.findUnique({ where: { id: input.planId } })
  if (!plan) throw new OperatorNotFoundError()
  if (plan.status !== 'PENDING') return plan
  if (plan.expiresAt <= input.now) {
    const expired = await database.operatorPlan.updateMany({
      where: { id: plan.id, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    })
    if (expired.count === 1) {
      await database.operatorProposal.updateMany({
        where: { planId: plan.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      })
      await auditPlan(database, plan, input.requestId, 'EXPIRED', null)
    }
    return (await database.operatorPlan.findUnique({ where: { id: plan.id } }))!
  }
  if (!sameHash(plan.argsHash, input.argsHash)) {
    throw new OperatorProposalError('ARGS_HASH_MISMATCH', 'The plan changed since it was shown.')
  }
  const approved = await database.operatorPlan.updateMany({
    where: { id: plan.id, status: 'PENDING', applyClaimedAt: null },
    data: {
      status: 'APPROVED',
      decidedByUserId: input.actorUserId,
      decidedAt: input.now,
      applyClaimedAt: input.now,
      leaseExpiresAt: new Date(input.now.getTime() + OPERATOR_APPLY_LEASE_MS),
      fenceToken: { increment: 1 },
      attempt: { increment: 1 },
    },
  })
  if (approved.count !== 1)
    return (await database.operatorPlan.findUnique({ where: { id: plan.id } }))!
  await auditPlan(
    database,
    plan,
    input.requestId,
    input.auto ? 'AUTO_APPROVED' : 'APPROVED',
    input.actorUserId,
  )
  await database.operatorProposal.updateMany({
    where: { planId: plan.id, status: 'PENDING' },
    data: {
      status: 'APPROVED',
      decidedByUserId: input.actorUserId,
      decidedAt: input.now,
      autoApproved: input.auto === true,
    },
  })
  const claimed = (await database.operatorPlan.findUnique({ where: { id: plan.id } }))!
  return drivePlan(claimed, input, dependencies)
}

/**
 * Applies the remaining steps of an approved plan in order, under the plan's current fence. It is
 * safe to call again after an interruption: steps that already applied are skipped and their results
 * feed later references, a step that may have committed stops the plan, and only the holder of the
 * newest fence may close the plan.
 */
export async function drivePlan(
  plan: PlanRow,
  input: Pick<PlanDecision, 'actorUserId' | 'requestId' | 'now'>,
  dependencies: OperatorDecisionDependencies,
): Promise<PlanRow> {
  const database = dependencies.database ?? db
  const steps = await database.operatorProposal.findMany({
    where: { planId: plan.id },
    orderBy: { planStepIndex: 'asc' },
  })
  const results = new Map<number, Record<string, unknown>>()
  let failedStepIndex: number | null = null
  let inFlight = false
  for (const step of steps) {
    if (step.status === 'APPLIED') {
      results.set(step.planStepIndex!, (step.result ?? {}) as Record<string, unknown>)
      continue
    }
    if (step.status !== 'APPROVED') {
      failedStepIndex = step.planStepIndex!
      break
    }
    if (step.applyClaimedAt !== null) {
      // Another claim holds this step; whoever owns it will finish or be reconciled.
      inFlight = true
      break
    }
    let resolvedArgs: unknown
    try {
      resolvedArgs = resolveStepReferences(step.args, results)
    } catch {
      failedStepIndex = step.planStepIndex!
      await database.operatorProposal.updateMany({
        where: { id: step.id, status: 'APPROVED' },
        data: { status: 'FAILED', failureCode: 'REFERENCE_UNRESOLVED' },
      })
      break
    }
    const applied = await applyApprovedProposal(
      step.id,
      { actorUserId: input.actorUserId, requestId: input.requestId, now: input.now, resolvedArgs },
      dependencies,
    )
    if (applied.status !== 'APPLIED') {
      failedStepIndex = step.planStepIndex!
      break
    }
    results.set(step.planStepIndex!, (applied.result ?? {}) as Record<string, unknown>)
  }
  if (inFlight) return (await database.operatorPlan.findUnique({ where: { id: plan.id } }))!
  if (failedStepIndex !== null) {
    // Later steps never run. They are closed so they cannot be approved on their own later.
    await database.operatorProposal.updateMany({
      where: { planId: plan.id, status: 'APPROVED', applyClaimedAt: null },
      data: { status: 'REJECTED', failureCode: 'PLAN_STOPPED' },
    })
  }
  // Fenced: a driver whose lease was taken over cannot close a plan someone else now owns.
  const closed = await database.operatorPlan.updateMany({
    where: { id: plan.id, status: 'APPROVED', fenceToken: plan.fenceToken },
    data:
      failedStepIndex === null
        ? { status: 'APPLIED', leaseExpiresAt: null }
        : { status: 'FAILED', failedStepIndex, leaseExpiresAt: null },
  })
  if (closed.count === 1) {
    await auditPlan(
      database,
      plan,
      input.requestId,
      failedStepIndex === null ? 'APPLIED' : `FAILED:${failedStepIndex}`,
      input.actorUserId,
    )
  }
  return (await database.operatorPlan.findUnique({ where: { id: plan.id } }))!
}

export async function rejectPlan(
  input: Pick<PlanDecision, 'planId' | 'actorUserId' | 'requestId' | 'now'>,
  database: OperatorDatabase = db,
): Promise<PlanRow> {
  const plan = await database.operatorPlan.findUnique({ where: { id: input.planId } })
  if (!plan) throw new OperatorNotFoundError()
  const changed = await database.operatorPlan.updateMany({
    where: { id: plan.id, status: 'PENDING' },
    data: { status: 'REJECTED', decidedByUserId: input.actorUserId, decidedAt: input.now },
  })
  if (changed.count === 1) {
    await database.operatorProposal.updateMany({
      where: { planId: plan.id, status: 'PENDING' },
      data: { status: 'REJECTED', decidedByUserId: input.actorUserId, decidedAt: input.now },
    })
    await auditPlan(database, plan, input.requestId, 'REJECTED', input.actorUserId)
  }
  return (await database.operatorPlan.findUnique({ where: { id: plan.id } }))!
}
