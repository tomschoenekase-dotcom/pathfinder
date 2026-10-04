import type { Prisma } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import {
  evaluateOffboardingGate,
  isStepPlanned,
  OFFBOARDING_EXECUTION_STEP_KEYS,
  plannedTargetsForStep,
  type OffboardingBillingFacts,
  type OffboardingExecutionRefusalCode,
  type OffboardingExecutionStepKeyName,
} from './offboarding-execution-policy'

/**
 * Durable bookkeeping for executing an approved offboarding plan. These actions only record: the
 * effects themselves (closing venues, stopping routines, revoking credentials, suspending access)
 * are done by the operator layer through the existing canonical actions, one step at a time, and
 * each step's outcome is written here so a partial failure can be resumed and a repeat changes
 * nothing. Nothing here deletes data or reaches a payment or identity provider.
 */

export type OffboardingExecutionActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
export type OffboardingExecutionClient = Pick<typeof db, '$transaction'>
export type OffboardingExecutionErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'CONFLICT'
  | OffboardingExecutionRefusalCode

export class OffboardingExecutionError extends Error {
  constructor(
    readonly code: OffboardingExecutionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OffboardingExecutionError'
  }
}

export type OffboardingStepSettlement = {
  status: 'COMPLETE' | 'SKIPPED' | 'ACTION_REQUIRED'
  /** A small plain object: counts and checklist lines, never content or secrets. */
  outcome: Record<string, unknown>
}

export type OffboardingExecutionView = {
  id: string
  tenantId: string
  planId: string
  status: 'IN_PROGRESS' | 'COMPLETED' | 'REINSTATED'
  billingHandled: boolean
  billingNote: string | null
  requestedBy: string
  lastOperationId: string
  startedAt: Date
  completedAt: Date | null
  reinstatedAt: Date | null
  steps: Array<{
    key: OffboardingExecutionStepKeyName
    status: 'PENDING' | 'COMPLETE' | 'SKIPPED' | 'FAILED' | 'ACTION_REQUIRED'
    attempts: number
    outcome: Prisma.JsonValue | null
    errorCode: string | null
    completedAt: Date | null
  }>
  priorState: Prisma.JsonValue
  replayed: boolean
}

const executionSelect = {
  id: true,
  tenantId: true,
  planId: true,
  status: true,
  billingHandled: true,
  billingNote: true,
  requestedBy: true,
  lastOperationId: true,
  startedAt: true,
  completedAt: true,
  reinstatedAt: true,
  priorState: true,
  steps: {
    select: {
      key: true,
      status: true,
      attempts: true,
      outcome: true,
      errorCode: true,
      completedAt: true,
    },
  },
} as const

const STEP_ORDER = new Map<string, number>(
  OFFBOARDING_EXECUTION_STEP_KEYS.map((key, i) => [key, i]),
)

function viewOf(
  row: {
    id: string
    tenantId: string
    planId: string
    status: OffboardingExecutionView['status']
    billingHandled: boolean
    billingNote: string | null
    requestedBy: string
    lastOperationId: string
    startedAt: Date
    completedAt: Date | null
    reinstatedAt: Date | null
    priorState: Prisma.JsonValue
    steps: Array<OffboardingExecutionView['steps'][number]>
  },
  replayed: boolean,
): OffboardingExecutionView {
  return {
    ...row,
    steps: [...row.steps].sort(
      (left, right) => (STEP_ORDER.get(left.key) ?? 99) - (STEP_ORDER.get(right.key) ?? 99),
    ),
    replayed,
  }
}

function requireActor(actor: OffboardingExecutionActor): void {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || !actor.id) {
    throw new OffboardingExecutionError(
      'INVALID_INPUT',
      'A human platform administrator is required',
    )
  }
}

async function lockPlan(tx: typeof db, tenantId: string, planId: string): Promise<void> {
  const key = `offboarding-execution:${tenantId}:${planId}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

// ---------------------------------------------------------------------------
// Facts and the gate
// ---------------------------------------------------------------------------

export type OffboardingExecutionFacts = {
  plan: {
    id: string
    status: string
    updatedAt: Date
    venueIds: string[]
    revocationTargets: string[]
  }
  tenantVenueIds: string[]
  tenantStatus: string
  billing: OffboardingBillingFacts
  executionStatus: 'IN_PROGRESS' | 'COMPLETED' | 'REINSTATED' | null
}

/** Reads what the gate needs. Tenant-scoped; a plan of another tenant is simply not found. */
export async function readOffboardingExecutionFacts(
  input: { tenantId: string; planId: string },
  client: Pick<typeof db, 'offboardingPlan' | 'venue' | 'tenant' | 'billingAccount'>,
): Promise<OffboardingExecutionFacts> {
  const plan = await client.offboardingPlan.findFirst({
    where: { id: input.planId, tenantId: input.tenantId },
    select: {
      id: true,
      status: true,
      updatedAt: true,
      revocationTargets: true,
      venueTargets: { select: { venueId: true } },
      execution: { select: { status: true } },
    },
  })
  if (!plan) throw new OffboardingExecutionError('NOT_FOUND', 'Offboarding plan not found')
  const [venues, tenant, account] = await Promise.all([
    client.venue.findMany({
      where: { tenantId: input.tenantId },
      select: { id: true },
      orderBy: { id: 'asc' },
    }),
    client.tenant.findUnique({ where: { id: input.tenantId }, select: { status: true } }),
    client.billingAccount.findUnique({
      where: { tenantId: input.tenantId },
      select: {
        status: true,
        billingMode: true,
        commercialAgreements: {
          where: { tenantId: input.tenantId },
          select: { status: true, billingMode: true, stripeSubscriptionId: true },
        },
      },
    }),
  ])
  if (!tenant) throw new OffboardingExecutionError('NOT_FOUND', 'Customer not found')
  return {
    plan: {
      id: plan.id,
      status: plan.status,
      updatedAt: plan.updatedAt,
      venueIds: plan.venueTargets.map((target) => target.venueId),
      revocationTargets: plan.revocationTargets,
    },
    tenantVenueIds: venues.map((venue) => venue.id),
    tenantStatus: tenant.status,
    billing: {
      accountStatus: account?.status ?? null,
      accountBillingMode: account?.billingMode ?? null,
      agreements: (account?.commercialAgreements ?? []).map((agreement) => ({
        status: agreement.status,
        billingMode: agreement.billingMode,
        hasProviderSubscription: agreement.stripeSubscriptionId !== null,
      })),
    },
    executionStatus: plan.execution?.status ?? null,
  }
}

export function assertOffboardingGate(
  facts: OffboardingExecutionFacts,
  billingHandled: boolean,
): void {
  const verdict = evaluateOffboardingGate({
    planStatus: facts.plan.status,
    planVenueIds: facts.plan.venueIds,
    tenantVenueIds: facts.tenantVenueIds,
    executionStatus: facts.executionStatus,
    billing: facts.billing,
    billingHandled,
  })
  if (!verdict.ok) throw new OffboardingExecutionError(verdict.code, verdict.message)
}

// ---------------------------------------------------------------------------
// Prior state: captured once, before any effect
// ---------------------------------------------------------------------------

/**
 * What the customer looked like before the first step ran. Held on the execution row so that
 * reinstating, and the list of things a person must switch back on by hand, never depend on a
 * half-finished step's partial memory.
 */
async function capturePriorState(tx: typeof db, tenantId: string, now: Date) {
  const [
    tenant,
    venues,
    memberships,
    routines,
    reports,
    connectors,
    identities,
    credentials,
    grants,
  ] = await Promise.all([
    tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true, updatedAt: true } }),
    tx.venue.findMany({
      where: { tenantId },
      select: { id: true, isActive: true },
      orderBy: { id: 'asc' },
    }),
    tx.tenantMembership.findMany({
      where: { tenantId },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
    }),
    tx.agentRoutine.findMany({
      where: { tenantId },
      select: { id: true, venueId: true, enabled: true },
      orderBy: { id: 'asc' },
    }),
    tx.venueReportConfiguration.findMany({
      where: { tenantId },
      select: { id: true, enabled: true },
      orderBy: { id: 'asc' },
    }),
    tx.liveDataConnector.findMany({
      where: { tenantId },
      select: { id: true, state: true },
      orderBy: { id: 'asc' },
    }),
    tx.agentIdentity.findMany({
      where: { tenantId },
      select: { id: true, enabled: true },
      orderBy: { id: 'asc' },
    }),
    tx.externalAccessCredential.findMany({
      where: { tenantId, revokedAt: null },
      select: { id: true, kind: true },
      orderBy: { id: 'asc' },
    }),
    tx.operatorGrant.findMany({
      where: { revokedAt: null, allTenants: false, tenantIds: { has: tenantId } },
      select: { id: true, tenantIds: true },
      orderBy: { id: 'asc' },
    }),
  ])
  if (!tenant) throw new OffboardingExecutionError('NOT_FOUND', 'Customer not found')
  return {
    capturedAt: now.toISOString(),
    tenant: { status: tenant.status, updatedAt: tenant.updatedAt.toISOString() },
    venues,
    memberships,
    routines,
    reportConfigurations: reports,
    liveDataConnectors: connectors,
    agentIdentities: identities,
    credentials,
    operatorGrants: grants,
  } satisfies Prisma.InputJsonObject
}

// ---------------------------------------------------------------------------
// Begin (or resume)
// ---------------------------------------------------------------------------

export type BeginOffboardingExecutionInput = {
  tenantId: string
  planId: string
  operationId: string
  billingHandled: boolean
  billingNote?: string | undefined
  actor: OffboardingExecutionActor
  now?: Date | undefined
}

/**
 * Starts the execution of a plan, or picks up the one already started. The gate is checked under
 * the plan's lock, the prior state is captured exactly once together with the row, and every step
 * row exists before any effect runs.
 */
export async function beginOffboardingExecutionAction(
  input: BeginOffboardingExecutionInput,
  client: OffboardingExecutionClient = db,
): Promise<OffboardingExecutionView> {
  requireActor(input.actor)
  const note = input.billingNote?.trim()
  if (input.billingHandled && (!note || note.length > 500)) {
    throw new OffboardingExecutionError(
      'INVALID_INPUT',
      'Saying billing is handled needs a note of up to 500 characters.',
    )
  }
  const now = input.now ?? new Date()
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await lockPlan(tx, input.tenantId, input.planId)
    const facts = await readOffboardingExecutionFacts(input, tx)
    const existing = await tx.offboardingExecution.findFirst({
      where: { planId: input.planId, tenantId: input.tenantId },
      select: executionSelect,
    })
    // A stronger billing statement is allowed on a resume; it is never weakened.
    const handled = input.billingHandled || existing?.billingHandled === true
    assertOffboardingGate(facts, handled)

    if (existing) {
      const upgraded = input.billingHandled && !existing.billingHandled
      await tx.offboardingExecution.updateMany({
        where: { id: existing.id, tenantId: input.tenantId },
        data: {
          lastOperationId: input.operationId,
          ...(upgraded ? { billingHandled: true, billingNote: note ?? null } : {}),
        },
      })
      const refreshed = await tx.offboardingExecution.findFirst({
        where: { id: existing.id, tenantId: input.tenantId },
        select: executionSelect,
      })
      return viewOf(refreshed ?? existing, true)
    }

    const priorState = await capturePriorState(tx, input.tenantId, now)
    const row = await tx.offboardingExecution.create({
      data: {
        tenantId: input.tenantId,
        planId: input.planId,
        status: 'IN_PROGRESS',
        billingHandled: input.billingHandled,
        billingNote: input.billingHandled ? (note ?? null) : null,
        requestedBy: input.actor.id,
        lastOperationId: input.operationId,
        startedAt: now,
        priorState,
      },
      select: { id: true },
    })
    await tx.offboardingExecutionStep.createMany({
      data: OFFBOARDING_EXECUTION_STEP_KEYS.map((key) => ({
        tenantId: input.tenantId,
        executionId: row.id,
        key,
      })),
    })
    const created = await tx.offboardingExecution.findFirstOrThrow({
      where: { id: row.id, tenantId: input.tenantId },
      select: executionSelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'offboarding-execution.started',
        targetType: 'OffboardingPlan',
        targetId: input.planId,
        afterState: {
          executionId: created.id,
          billingHandled: input.billingHandled,
          venueCount: facts.plan.venueIds.length,
        },
      },
      tx,
    )
    return viewOf(created, false)
  })
}

export async function readOffboardingExecutionAction(
  input: { tenantId: string; planId: string },
  client: Pick<typeof db, 'offboardingExecution'> = db,
): Promise<OffboardingExecutionView | null> {
  const row = await client.offboardingExecution.findFirst({
    where: { planId: input.planId, tenantId: input.tenantId },
    select: executionSelect,
  })
  return row ? viewOf(row, false) : null
}

// ---------------------------------------------------------------------------
// Step outcomes
// ---------------------------------------------------------------------------

/** Evidence the existing plan model already knows how to hold: one row per venue per target. */
const EVIDENCE_REFERENCE = (executionId: string, key: string) =>
  `offboarding-execution:${executionId}:${key}`.slice(0, 500)

export type SettleOffboardingStepInput = {
  tenantId: string
  executionId: string
  planId: string
  key: OffboardingExecutionStepKeyName
  settlement: OffboardingStepSettlement
  /** Plan venues and the targets the plan asked for, to write revocation evidence once. */
  evidence?: { venueIds: readonly string[]; plannedTargets: readonly string[] }
  actor: OffboardingExecutionActor
  now?: Date | undefined
}

/**
 * Records a step as settled. Only a step that is still PENDING or FAILED can settle, so a repeat
 * settles nothing and writes no second evidence. Revocation evidence for the plan's targets is
 * written in the same transaction as the settlement.
 */
export async function settleOffboardingExecutionStepAction(
  input: SettleOffboardingStepInput,
  client: OffboardingExecutionClient = db,
): Promise<{ settled: boolean }> {
  requireActor(input.actor)
  const now = input.now ?? new Date()
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const changed = await tx.offboardingExecutionStep.updateMany({
      where: {
        tenantId: input.tenantId,
        executionId: input.executionId,
        key: input.key,
        status: { in: ['PENDING', 'FAILED'] },
      },
      data: {
        status: input.settlement.status,
        outcome: input.settlement.outcome as Prisma.InputJsonObject,
        errorCode: null,
        completedAt: now,
        attempts: { increment: 1 },
      },
    })
    if (changed.count !== 1) return { settled: false }
    const targets =
      input.settlement.status === 'COMPLETE' && input.evidence
        ? plannedTargetsForStep(input.key, input.evidence.plannedTargets)
        : []
    if (input.evidence && targets.length > 0) {
      await tx.offboardingRevocationEvidence.createMany({
        data: input.evidence.venueIds.flatMap((venueId) =>
          targets.map((target) => ({
            tenantId: input.tenantId,
            venueId,
            planId: input.planId,
            target,
            outcome: 'COMPLETE' as const,
            evidenceReference: EVIDENCE_REFERENCE(input.executionId, input.key),
            recordedBy: input.actor.id,
            recordedAt: now,
          })),
        ),
      })
    }
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'offboarding-execution.step-settled',
        targetType: 'OffboardingPlan',
        targetId: input.planId,
        afterState: {
          executionId: input.executionId,
          step: input.key,
          status: input.settlement.status,
        },
      },
      tx,
    )
    return { settled: true }
  })
}

/** Records a step failure so the next attempt knows where to resume. Final steps are untouched. */
export async function failOffboardingExecutionStepAction(
  input: {
    tenantId: string
    executionId: string
    key: OffboardingExecutionStepKeyName
    errorCode: string
  },
  client: Pick<typeof db, 'offboardingExecutionStep'> = db,
): Promise<void> {
  const errorCode = /^[A-Z0-9_:-]{1,60}$/u.test(input.errorCode) ? input.errorCode : 'STEP_FAILED'
  await client.offboardingExecutionStep.updateMany({
    where: {
      tenantId: input.tenantId,
      executionId: input.executionId,
      key: input.key,
      status: { in: ['PENDING', 'FAILED'] },
    },
    data: { status: 'FAILED', errorCode, completedAt: null, attempts: { increment: 1 } },
  })
}

/** Marks the execution complete once no step is pending or failed. Idempotent. */
export async function completeOffboardingExecutionAction(
  input: {
    tenantId: string
    executionId: string
    planId: string
    actor: OffboardingExecutionActor
    now?: Date | undefined
  },
  client: OffboardingExecutionClient = db,
): Promise<{ completed: boolean }> {
  requireActor(input.actor)
  const now = input.now ?? new Date()
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const open = await tx.offboardingExecutionStep.count({
      where: {
        tenantId: input.tenantId,
        executionId: input.executionId,
        status: { in: ['PENDING', 'FAILED'] },
      },
    })
    if (open > 0) return { completed: false }
    const changed = await tx.offboardingExecution.updateMany({
      where: { id: input.executionId, tenantId: input.tenantId, status: 'IN_PROGRESS' },
      data: { status: 'COMPLETED', completedAt: now },
    })
    if (changed.count !== 1) return { completed: false }
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'offboarding-execution.completed',
        targetType: 'OffboardingPlan',
        targetId: input.planId,
        afterState: { executionId: input.executionId },
      },
      tx,
    )
    return { completed: true }
  })
}

/** Closes a completed execution after the reinstatable parts were restored. Idempotent. */
export async function markOffboardingExecutionReinstatedAction(
  input: {
    tenantId: string
    executionId: string
    planId: string
    actor: OffboardingExecutionActor
    now?: Date | undefined
  },
  client: OffboardingExecutionClient = db,
): Promise<{ reinstated: boolean }> {
  requireActor(input.actor)
  const now = input.now ?? new Date()
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const changed = await tx.offboardingExecution.updateMany({
      where: { id: input.executionId, tenantId: input.tenantId, status: 'COMPLETED' },
      data: { status: 'REINSTATED', reinstatedAt: now, reinstatedBy: input.actor.id },
    })
    if (changed.count !== 1) return { reinstated: false }
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'offboarding-execution.reinstated',
        targetType: 'OffboardingPlan',
        targetId: input.planId,
        afterState: { executionId: input.executionId },
      },
      tx,
    )
    return { reinstated: true }
  })
}

/** Which steps a plan asks for, in execution order. Pure, for previews and tests. */
export function plannedOffboardingSteps(
  plannedTargets: readonly string[],
): Array<{ key: OffboardingExecutionStepKeyName; planned: boolean }> {
  return OFFBOARDING_EXECUTION_STEP_KEYS.map((key) => ({
    key,
    planned: isStepPlanned(key, plannedTargets),
  }))
}
