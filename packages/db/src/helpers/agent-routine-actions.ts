import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  CreateAgentRoutineInput as CreateAgentRoutineInputSchema,
  ROUTINE_BUDGET_EXCEEDED,
  RoutineBudget as RoutineBudgetSchema,
  RoutineStopRules as RoutineStopRulesSchema,
  SetAgentRoutineEnabledInput as SetAgentRoutineEnabledInputSchema,
} from '@pathfinder/contracts'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { writeAuditLogStrict } from './audit'
import { bindEligibleAgentWorkflows } from './agent-workflow-run-binding'
import {
  evaluateRoutineStopRules,
  recordRoutineStop,
  reserveAgentRoutineBudget,
  routineBudgetOf,
} from './agent-routine-guards'

export type AgentRoutineActionClient = Pick<typeof db, '$transaction' | 'agentRoutine'>

export class AgentRoutineActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'BAD_REQUEST',
    message: string,
  ) {
    super(message)
    this.name = 'AgentRoutineActionError'
  }
}

function assertScopedStopRules(rules: z.output<typeof RoutineStopRulesSchema> | undefined) {
  if (rules?.subject?.kind === 'PROSPECT_CONTACT') {
    throw new AgentRoutineActionError(
      'FORBIDDEN',
      'A tenant routine cannot bind a platform prospect contact without a proven tenant scope',
    )
  }
}

const dispatchInputSchema = z
  .object({
    routineId: z.string().trim().min(1).max(191),
    now: z.date(),
  })
  .strict()

function nextRunAt(now: Date, intervalSeconds: number) {
  return new Date(now.getTime() + intervalSeconds * 1_000)
}

function startOfUtcDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function routineAdvisoryLockKey(routineId: string) {
  return `pathfinder:agent-routine:${routineId}`
}

function routineCreateAdvisoryLockKey(input: {
  tenantId: string
  venueId: string
  routineKey: string
}) {
  return `pathfinder:agent-routine:create:${input.tenantId}:${input.venueId}:${input.routineKey}`
}

function sameRoutine(
  existing: {
    agentIdentityId: string
    prompt: string
    requestedOperation: string
    intervalSeconds: number
    maxAttempts: number
    maxRunsPerDay: number
    perRunBudgetE8Usd: bigint | null
    dailyBudgetE8Usd: bigint | null
    requiredWorkerRoles: string[]
    requiredWorkerCapabilities: string[]
    stopRules: unknown
    budgetCents: number | null
    budgetCurrency: string | null
    budgetPeriod: 'DAY' | 'WEEK' | 'MONTH' | null
    estimatedRunCostCents: number | null
  },
  input: z.output<typeof CreateAgentRoutineInputSchema>,
) {
  return (
    JSON.stringify(canonicalStopRules(existing.stopRules)) ===
      JSON.stringify(canonicalStopRules(input.stopRules)) &&
    JSON.stringify(routineBudgetOf(existing)) ===
      JSON.stringify(
        input.budget
          ? {
              budgetCents: input.budget.amountCents,
              budgetCurrency: input.budget.currency,
              budgetPeriod: input.budget.period,
              estimatedRunCostCents: input.budget.estimatedRunCostCents,
            }
          : null,
      ) &&
    sameCoreDefinition(existing, input)
  )
}

/** Key order must not decide whether two stop-rule documents are the same. */
function canonicalStopRules(raw: unknown) {
  const parsed = RoutineStopRulesSchema.safeParse(raw ?? {})
  const rules = parsed.success ? parsed.data : {}
  return {
    subject: rules.subject ? { kind: rules.subject.kind, id: rules.subject.id } : null,
    maxReminders: rules.maxReminders ?? null,
    endsAt: rules.endsAt ? new Date(rules.endsAt).toISOString() : null,
  }
}

function sameCoreDefinition(
  existing: {
    agentIdentityId: string
    prompt: string
    requestedOperation: string
    intervalSeconds: number
    maxAttempts: number
    maxRunsPerDay: number
    perRunBudgetE8Usd: bigint | null
    dailyBudgetE8Usd: bigint | null
    requiredWorkerRoles: string[]
    requiredWorkerCapabilities: string[]
  },
  input: z.output<typeof CreateAgentRoutineInputSchema>,
) {
  return (
    existing.agentIdentityId === input.agentIdentityId &&
    existing.prompt === input.prompt &&
    existing.requestedOperation === input.requestedOperation &&
    existing.intervalSeconds === input.intervalSeconds &&
    existing.maxAttempts === input.maxAttempts &&
    existing.maxRunsPerDay === input.maxRunsPerDay &&
    existing.perRunBudgetE8Usd === null &&
    existing.dailyBudgetE8Usd === null &&
    JSON.stringify(existing.requiredWorkerRoles) === JSON.stringify(input.requiredWorkerRoles) &&
    JSON.stringify(existing.requiredWorkerCapabilities) ===
      JSON.stringify(input.requiredWorkerCapabilities)
  )
}

/** Creates a saved routine only. It never schedules or executes work. */
export async function createAgentRoutineAction(
  rawInput: z.input<typeof CreateAgentRoutineInputSchema>,
  actorId: string,
  client: AgentRoutineActionClient = db,
) {
  const input = CreateAgentRoutineInputSchema.parse(rawInput)
  assertScopedStopRules(input.stopRules)
  return client.$transaction(async (tx) => {
    // Serialize the unique-definition decision so concurrent identical creates
    // replay cleanly and differing definitions return the domain conflict.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${routineCreateAdvisoryLockKey(input)}, 0))`
    const venue = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (!venue) throw new AgentRoutineActionError('NOT_FOUND', 'Venue not found')
    const identity = await tx.agentIdentity.findFirst({
      where: {
        id: input.agentIdentityId,
        tenantId: input.tenantId,
        OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
      },
      select: { id: true },
    })
    if (!identity)
      throw new AgentRoutineActionError('FORBIDDEN', 'Agent identity is not in venue scope')

    const existing = await tx.agentRoutine.findFirst({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        routineKey: input.routineKey,
      },
    })
    if (existing) {
      if (!sameRoutine(existing, input))
        throw new AgentRoutineActionError(
          'CONFLICT',
          'Routine key is already used for different work',
        )
      return { routine: existing, replayed: true as const }
    }

    const routine = await tx.agentRoutine.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        routineKey: input.routineKey,
        agentIdentityId: input.agentIdentityId,
        requestedOperation: input.requestedOperation,
        prompt: input.prompt,
        intervalSeconds: input.intervalSeconds,
        maxAttempts: input.maxAttempts,
        maxRunsPerDay: input.maxRunsPerDay,
        // USD ceilings remain unsupported until a bridge can enforce one
        // before provider invocation and report trustworthy measured usage.
        perRunBudgetE8Usd: null,
        dailyBudgetE8Usd: null,
        requiredWorkerRoles: input.requiredWorkerRoles,
        requiredWorkerCapabilities: input.requiredWorkerCapabilities,
        stopRules: input.stopRules,
        ...(input.budget
          ? {
              budgetCents: input.budget.amountCents,
              budgetCurrency: input.budget.currency,
              budgetPeriod: input.budget.period,
              estimatedRunCostCents: input.budget.estimatedRunCostCents,
            }
          : {}),
        // Definitions begin inert. A separate human action and server flag are
        // both required before the scheduler can create an AgentRun.
        enabled: false,
        nextRunAt: null,
        createdBy: actorId,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorType: 'HUMAN',
        actorId,
        actorRole: 'PLATFORM_ADMIN',
        idempotencyKey: input.operationId,
        action: 'agent-routine.created',
        targetType: 'AgentRoutine',
        targetId: routine.id,
        afterState: {
          venueId: routine.venueId,
          routineKey: routine.routineKey,
          enabled: false,
          intervalSeconds: routine.intervalSeconds,
        },
      },
      tx,
    )
    return { routine, replayed: false as const }
  })
}

/**
 * Edits a saved routine's prompt, interval or daily run limit. Only a disabled routine can change,
 * so an enabled routine can never be altered without first being stopped, and the next enable is a
 * separate decision. `expectedUpdatedAt` makes an edit over a moved definition a conflict.
 */
export async function updateAgentRoutineDefinitionAction(
  rawInput: {
    operationId: string
    tenantId: string
    venueId: string
    routineId: string
    expectedUpdatedAt: Date
    prompt?: string
    intervalSeconds?: number
    maxRunsPerDay?: number
    stopRules?: z.input<typeof RoutineStopRulesSchema>
    /** null removes the budget; omitted leaves it as it is. */
    budget?: z.input<typeof RoutineBudgetSchema> | null
  },
  actorId: string,
  client: AgentRoutineActionClient = db,
) {
  const input = z
    .object({
      operationId: z.string().uuid(),
      tenantId: z.string().trim().min(1).max(191),
      venueId: z.string().trim().min(1).max(191),
      routineId: z.string().trim().min(1).max(191),
      expectedUpdatedAt: z.date(),
      prompt: z.string().trim().min(1).max(10_000).optional(),
      intervalSeconds: z
        .number()
        .int()
        .min(60)
        .max(7 * 24 * 60 * 60)
        .optional(),
      maxRunsPerDay: z.number().int().min(1).max(1_440).optional(),
      stopRules: RoutineStopRulesSchema.optional(),
      budget: RoutineBudgetSchema.nullable().optional(),
    })
    .strict()
    .parse(rawInput)
  assertScopedStopRules(input.stopRules)
  return client.$transaction(async (tx) => {
    // No advisory lock: the write below is a compare-and-set on `enabled: false` and the observed
    // `updatedAt`, so a concurrent enable or edit changes the row and this update affects 0 rows.
    const routine = await tx.agentRoutine.findFirst({
      where: { id: input.routineId, tenantId: input.tenantId, venueId: input.venueId },
    })
    if (!routine) throw new AgentRoutineActionError('NOT_FOUND', 'Routine not found')
    if (routine.enabled) {
      throw new AgentRoutineActionError('CONFLICT', 'Disable the routine before editing it')
    }
    if (routine.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      throw new AgentRoutineActionError('CONFLICT', 'The routine changed after it was read')
    }
    const data = {
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.intervalSeconds !== undefined ? { intervalSeconds: input.intervalSeconds } : {}),
      ...(input.maxRunsPerDay !== undefined ? { maxRunsPerDay: input.maxRunsPerDay } : {}),
      ...(input.stopRules !== undefined ? { stopRules: input.stopRules } : {}),
      ...(input.budget === null
        ? {
            budgetCents: null,
            budgetCurrency: null,
            budgetPeriod: null,
            estimatedRunCostCents: null,
          }
        : input.budget !== undefined
          ? {
              budgetCents: input.budget.amountCents,
              budgetCurrency: input.budget.currency,
              budgetPeriod: input.budget.period,
              estimatedRunCostCents: input.budget.estimatedRunCostCents,
            }
          : {}),
    }
    const changed = await tx.agentRoutine.updateMany({
      where: {
        id: routine.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        enabled: false,
        updatedAt: input.expectedUpdatedAt,
      },
      data,
    })
    if (changed.count !== 1) {
      throw new AgentRoutineActionError('CONFLICT', 'The routine changed while it was updated')
    }
    const updated = await tx.agentRoutine.findFirst({
      where: { id: routine.id, tenantId: input.tenantId, venueId: input.venueId },
    })
    if (!updated) throw new AgentRoutineActionError('NOT_FOUND', 'Routine not found after update')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorType: 'HUMAN',
        actorId,
        actorRole: 'PLATFORM_ADMIN',
        idempotencyKey: input.operationId,
        action: 'agent-routine.updated',
        targetType: 'AgentRoutine',
        targetId: updated.id,
        // The prompt itself is not copied into the audit trail.
        beforeState: {
          intervalSeconds: routine.intervalSeconds,
          maxRunsPerDay: routine.maxRunsPerDay,
          budget: routineBudgetOf(routine),
        },
        afterState: {
          enabled: false,
          changedPrompt: input.prompt !== undefined,
          intervalSeconds: updated.intervalSeconds,
          maxRunsPerDay: updated.maxRunsPerDay,
          changedStopRules: input.stopRules !== undefined,
          budget: routineBudgetOf(updated),
        },
      },
      tx,
    )
    return { routine: updated }
  })
}

/** Enables or disables a saved routine. Enabling only makes it due; it does
 * not bypass the independently default-dark worker runtime gate. */
export async function setAgentRoutineEnabledAction(
  rawInput: z.input<typeof SetAgentRoutineEnabledInputSchema>,
  actorId: string,
  options: { now?: Date; client?: AgentRoutineActionClient } = {},
) {
  const input = SetAgentRoutineEnabledInputSchema.parse(rawInput)
  const now = options.now ?? new Date()
  const client = options.client ?? db
  return client.$transaction(async (tx) => {
    // Shares the dispatch lock. When disable returns, a concurrent scheduler
    // cannot still materialize a new AgentRun from the old enabled state.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${routineAdvisoryLockKey(input.routineId)}, 0))`
    const routine = await tx.agentRoutine.findFirst({
      where: { id: input.routineId, tenantId: input.tenantId, venueId: input.venueId },
    })
    if (!routine) throw new AgentRoutineActionError('NOT_FOUND', 'Routine not found')
    if (routine.enabled === input.enabled)
      return { routine, replayed: true as const, executionTriggered: false as const }
    const changed = await tx.agentRoutine.updateMany({
      where: {
        id: routine.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        enabled: routine.enabled,
      },
      data: input.enabled
        ? { enabled: true, nextRunAt: now, lastSkipReason: null, stoppedAt: null, stopReason: null }
        : { enabled: false, nextRunAt: null, lastSkipReason: 'DISABLED' },
    })
    if (changed.count !== 1)
      throw new AgentRoutineActionError(
        'CONFLICT',
        'Routine changed while updating its enabled state',
      )
    const updated = await tx.agentRoutine.findFirst({
      where: { id: routine.id, tenantId: input.tenantId, venueId: input.venueId },
    })
    if (!updated) throw new AgentRoutineActionError('NOT_FOUND', 'Routine not found after update')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorType: 'HUMAN',
        actorId,
        actorRole: 'PLATFORM_ADMIN',
        idempotencyKey: input.operationId,
        action: input.enabled ? 'agent-routine.enabled' : 'agent-routine.disabled',
        targetType: 'AgentRoutine',
        targetId: updated.id,
        afterState: {
          enabled: updated.enabled,
          nextRunAt: updated.nextRunAt?.toISOString() ?? null,
        },
      },
      tx,
    )
    return { routine: updated, replayed: false as const, executionTriggered: false as const }
  })
}

type DispatchOutcome =
  | { routineId: string; status: 'DISPATCHED'; agentRunId: string; tenantId: string }
  | { routineId: string; status: 'SKIPPED'; reason: string }
  /** A stop rule was met: the routine is now disabled with the reason recorded, and nothing ran. */
  | { routineId: string; status: 'STOPPED'; reason: string }

/**
 * Claims one due definition under a transaction-scoped advisory lock and
 * materializes exactly one bridge-only AgentRun. It does not enqueue a managed
 * provider job: a worker with the bound role and capabilities must claim it.
 */
export async function dispatchDueAgentRoutineAction(
  rawInput: z.input<typeof dispatchInputSchema>,
  client: AgentRoutineActionClient = db,
): Promise<DispatchOutcome> {
  const input = dispatchInputSchema.parse(rawInput)
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${routineAdvisoryLockKey(input.routineId)}, 0))`
    const routine = await tx.agentRoutine.findUnique({
      where: { id: input.routineId },
      include: {
        agentIdentity: {
          select: {
            id: true,
            agentType: true,
            accessScope: true,
            accessCapabilities: true,
            autonomyLevel: true,
            autonomousActions: true,
            defaultProvider: true,
            defaultModel: true,
            enabled: true,
            venueId: true,
          },
        },
      },
    })
    if (!routine || !routine.enabled || !routine.nextRunAt || routine.nextRunAt > input.now)
      return { routineId: input.routineId, status: 'SKIPPED', reason: 'NOT_DUE' }

    const scheduledFor = routine.nextRunAt
    const nextDue = nextRunAt(input.now, routine.intervalSeconds)
    const identity = routine.agentIdentity

    // Stop rules are evaluated before any other decision or effect, so a reminder whose purpose is
    // met (or no longer valid) never produces a stale run. Recording is a compare-and-set.
    const stopReason = await evaluateRoutineStopRules(tx, routine, input.now)
    if (stopReason) {
      const { recorded } = await recordRoutineStop(tx, routine, stopReason, input.now)
      if (recorded) {
        await writeAuditLogStrict(
          {
            tenantId: routine.tenantId,
            actorType: 'SYSTEM',
            actorId: `agent-routine:${routine.id}`,
            actorRole: 'SYSTEM',
            systemJobId: routine.id,
            idempotencyKey: randomUUID(),
            action: 'agent-routine.stopped',
            targetType: 'AgentRoutine',
            targetId: routine.id,
            afterState: { reason: stopReason, stoppedAt: input.now.toISOString() },
          },
          tx,
        )
      }
      return { routineId: routine.id, status: 'STOPPED', reason: stopReason }
    }
    if (routine.maxAttempts !== 1) {
      await tx.agentRoutine.update({
        where: { id: routine.id },
        data: { nextRunAt: nextDue, lastSkipReason: 'UNSUPPORTED_MAX_ATTEMPTS' },
      })
      return { routineId: routine.id, status: 'SKIPPED', reason: 'UNSUPPORTED_MAX_ATTEMPTS' }
    }
    if (!identity.enabled || (identity.venueId !== null && identity.venueId !== routine.venueId)) {
      await tx.agentRoutine.update({
        where: { id: routine.id },
        data: { nextRunAt: nextDue, lastSkipReason: 'IDENTITY_UNAVAILABLE' },
      })
      return { routineId: routine.id, status: 'SKIPPED', reason: 'IDENTITY_UNAVAILABLE' }
    }

    // A routine is intentionally serial. This fences both a disconnected
    // bridge and a slow monitor from accumulating an unbounded queued backlog.
    const activeDispatch = await tx.agentRoutineDispatch.findFirst({
      where: {
        routineId: routine.id,
        agentRun: {
          status: { in: ['QUEUED', 'RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL'] },
        },
      },
      select: { id: true },
    })
    if (activeDispatch) {
      await tx.agentRoutine.update({
        where: { id: routine.id },
        data: { nextRunAt: nextDue, lastSkipReason: 'ACTIVE_RUN_EXISTS' },
      })
      return { routineId: routine.id, status: 'SKIPPED', reason: 'ACTIVE_RUN_EXISTS' }
    }

    if (routine.dailyBudgetE8Usd !== null || routine.perRunBudgetE8Usd !== null) {
      // Legacy/manual budget rows are deliberately inert. The bridge cannot
      // prove a pre-call provider cap or trustworthy usage report yet.
      await tx.agentRoutine.update({
        where: { id: routine.id },
        data: { nextRunAt: nextDue, lastSkipReason: 'UNSUPPORTED_BUDGET_ENFORCEMENT' },
      })
      return { routineId: routine.id, status: 'SKIPPED', reason: 'UNSUPPORTED_BUDGET_ENFORCEMENT' }
    }

    const todaysDispatches = await tx.agentRoutineDispatch.findMany({
      where: { routineId: routine.id, scheduledFor: { gte: startOfUtcDay(input.now) } },
      select: { id: true },
      take: routine.maxRunsPerDay + 1,
    })
    if (todaysDispatches.length >= routine.maxRunsPerDay) {
      const reason = 'DAILY_RUN_LIMIT_REACHED'
      await tx.agentRoutine.update({
        where: { id: routine.id },
        data: { nextRunAt: nextDue, lastSkipReason: reason },
      })
      return { routineId: routine.id, status: 'SKIPPED', reason }
    }

    // Budget: reserve a conservative estimate atomically before the run exists. A refusal records
    // BUDGET_EXCEEDED and returns without creating anything.
    const budget = routineBudgetOf(routine)
    let reservedCostCents: number | null = null
    if (budget) {
      const reservation = await reserveAgentRoutineBudget(tx, { ...routine, ...budget }, input.now)
      if (!reservation.ok) {
        const firstRefusal = routine.lastSkipReason !== ROUTINE_BUDGET_EXCEEDED
        await tx.agentRoutine.update({
          where: { id: routine.id },
          data: { nextRunAt: nextDue, lastSkipReason: ROUTINE_BUDGET_EXCEEDED },
        })
        if (firstRefusal) {
          await writeAuditLogStrict(
            {
              tenantId: routine.tenantId,
              actorType: 'SYSTEM',
              actorId: `agent-routine:${routine.id}`,
              actorRole: 'SYSTEM',
              systemJobId: routine.id,
              idempotencyKey: randomUUID(),
              action: 'agent-routine.budget-exceeded',
              targetType: 'AgentRoutine',
              targetId: routine.id,
              afterState: {
                estimatedRunCostCents: budget.estimatedRunCostCents,
                remainingCents: reservation.remainingCents,
                currency: budget.budgetCurrency,
                period: budget.budgetPeriod,
              },
            },
            tx,
          )
        }
        return { routineId: routine.id, status: 'SKIPPED', reason: ROUTINE_BUDGET_EXCEEDED }
      }
      reservedCostCents = reservation.reservedCents
    }

    const operationId = randomUUID()
    const run = await tx.agentRun.create({
      data: {
        operationId,
        tenantId: routine.tenantId,
        venueId: routine.venueId,
        agentIdentityId: identity.id,
        runType: identity.agentType,
        requestedOperation: routine.requestedOperation,
        requestPrompt: routine.prompt,
        scopeSnapshot: {
          accessScope: identity.accessScope,
          accessCapabilities: identity.accessCapabilities,
          autonomyLevel: identity.autonomyLevel,
          autonomousActions: identity.autonomousActions,
          routine: {
            routineId: routine.id,
            routineKey: routine.routineKey,
            scheduledFor: scheduledFor.toISOString(),
            budgetEnforcement: budget ? 'RESERVED_ESTIMATE' : 'DEFERRED',
            ...(reservedCostCents !== null ? { reservedCostCents } : {}),
          },
          requiredWorkerRoles: routine.requiredWorkerRoles,
          requiredWorkerCapabilities: routine.requiredWorkerCapabilities,
        },
        status: 'QUEUED',
        maxAttempts: routine.maxAttempts,
        modelProvider: identity.defaultProvider,
        modelName: identity.defaultModel,
        initiatedByType: 'SYSTEM',
        initiatedById: `agent-routine:${routine.id}`,
      },
      select: { id: true },
    })
    await bindEligibleAgentWorkflows(tx, {
      tenantId: routine.tenantId,
      venueId: routine.venueId,
      agentRunId: run.id,
      runType: identity.agentType,
      operation: routine.requestedOperation,
    })
    await tx.agentRoutineDispatch.create({
      data: {
        tenantId: routine.tenantId,
        venueId: routine.venueId,
        routineId: routine.id,
        scheduledFor,
        agentRunId: run.id,
        ...(reservedCostCents !== null ? { reservedCostCents } : {}),
      },
    })
    await tx.agentRoutine.update({
      where: { id: routine.id },
      data: {
        nextRunAt: nextDue,
        lastRunAt: input.now,
        lastSkipReason: null,
      },
    })
    await tx.agentTimelineEvent.create({
      data: {
        tenantId: routine.tenantId,
        venueId: routine.venueId,
        agentRunId: run.id,
        actorType: 'SYSTEM',
        actorId: `agent-routine:${routine.id}`,
        eventType: 'ROUTINE_QUEUED',
        message: `Routine ${routine.routineKey} queued a bounded monitoring run.`,
        data: { routineId: routine.id, scheduledFor: scheduledFor.toISOString() },
      },
    })
    await tx.agentMessage.create({
      data: {
        tenantId: routine.tenantId,
        venueId: routine.venueId,
        agentRunId: run.id,
        agentIdentityId: identity.id,
        role: 'SYSTEM',
        messageType: 'PROMPT',
        content: routine.prompt,
        actorId: `agent-routine:${routine.id}`,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: routine.tenantId,
        actorType: 'SYSTEM',
        actorId: `agent-routine:${routine.id}`,
        actorRole: 'SYSTEM',
        systemJobId: routine.id,
        idempotencyKey: operationId,
        action: 'agent-routine.dispatched',
        targetType: 'AgentRun',
        targetId: run.id,
        afterState: { routineId: routine.id, scheduledFor: scheduledFor.toISOString() },
      },
      tx,
    )
    return {
      routineId: routine.id,
      status: 'DISPATCHED',
      agentRunId: run.id,
      tenantId: routine.tenantId,
    }
  })
}

/** Looks up a bounded due set. Each routine is rechecked and locked before it
 * can create a run, so duplicate scheduler jobs are harmless. */
export async function dispatchDueAgentRoutinesAction(
  options: { now?: Date; limit?: number; client?: AgentRoutineActionClient } = {},
) {
  const now = options.now ?? new Date()
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100)
  const client = options.client ?? db
  // Reviewed platform-worker boundary: it discovers only bounded opaque due
  // IDs, then transactionally rechecks every definition before materializing
  // an exact tenant/venue AgentRun. No caller-supplied tenant scope is used.
  return withTenantIsolationBypass(async () => {
    const due = await client.agentRoutine.findMany({
      where: { enabled: true, nextRunAt: { lte: now } },
      select: { id: true },
      orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      take: limit,
    })
    const outcomes: DispatchOutcome[] = []
    for (const routine of due) {
      outcomes.push(await dispatchDueAgentRoutineAction({ routineId: routine.id, now }, client))
    }
    return outcomes
  })
}
