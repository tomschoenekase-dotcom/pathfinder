import { RoutineStopRules } from '@pathfinder/contracts'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { budgetPeriodBounds, routineBudgetOf } from '@pathfinder/db'

import { operatorUntrustedText } from '../crm-projection'
import { assertTenantInGrant, assertVenueInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'
import { decodeKeysetCursor, encodeKeysetCursor, pageResult, requireCursorInScope } from './page'

const routinesList: OperatorReadTool = {
  name: 'routines.list',
  capability: 'routines:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['routines.list'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    if (input.venueId)
      await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const base = { tenantId: input.tenantId, ...(input.venueId ? { venueId: input.venueId } : {}) }
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.agentRoutine.findFirst({
        where: { ...base, id, createdAt: after!.at },
        select: { id: true },
      }),
    )
    const rows = await context.database.agentRoutine.findMany({
      where: {
        ...base,
        ...(after
          ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        venueId: true,
        routineKey: true,
        requestedOperation: true,
        intervalSeconds: true,
        maxAttempts: true,
        maxRunsPerDay: true,
        requiredWorkerRoles: true,
        requiredWorkerCapabilities: true,
        enabled: true,
        nextRunAt: true,
        lastRunAt: true,
        lastSkipReason: true,
        stoppedAt: true,
        stopReason: true,
        createdAt: true,
        updatedAt: true,
        agentIdentity: { select: { id: true, name: true, enabled: true } },
        dispatches: {
          where: { tenantId: input.tenantId },
          orderBy: [{ scheduledFor: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { agentRunId: true, scheduledFor: true, agentRun: { select: { status: true } } },
        },
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        routineId: row.id,
        venueId: row.venueId,
        routineKey: operatorUntrustedText(row.routineKey),
        requestedOperation: operatorUntrustedText(row.requestedOperation),
        intervalSeconds: row.intervalSeconds,
        maxAttempts: row.maxAttempts,
        maxRunsPerDay: row.maxRunsPerDay,
        requiredWorkerRoles: row.requiredWorkerRoles.map((value) => operatorUntrustedText(value)),
        requiredWorkerCapabilities: row.requiredWorkerCapabilities.map((value) =>
          operatorUntrustedText(value),
        ),
        enabled: row.enabled,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        lastRunAt: row.lastRunAt?.toISOString() ?? null,
        lastSkipReason: row.lastSkipReason ? operatorUntrustedText(row.lastSkipReason) : null,
        stoppedAt: row.stoppedAt?.toISOString() ?? null,
        stopReason: row.stopReason,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        agentIdentity: {
          identityId: row.agentIdentity.id,
          name: operatorUntrustedText(row.agentIdentity.name),
          enabled: row.agentIdentity.enabled,
        },
        latestDispatch: row.dispatches[0]
          ? {
              runId: row.dispatches[0].agentRunId,
              scheduledFor: row.dispatches[0].scheduledFor.toISOString(),
              runStatus: row.dispatches[0].agentRun.status,
            }
          : null,
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.createdAt, page.at(-1)!.id)
        : null,
    )
  },
}

const DAY_MS = 24 * 60 * 60 * 1000
const ACTIVE_RUN_STATUSES = ['QUEUED', 'RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL']
/** Skip reasons the dispatcher writes when it refuses to run a routine that is due. */
const BLOCKING_SKIP_REASONS = new Set([
  'IDENTITY_UNAVAILABLE',
  'UNSUPPORTED_MAX_ATTEMPTS',
  'UNSUPPORTED_BUDGET_ENFORCEMENT',
  'DAILY_RUN_LIMIT_REACHED',
  'BUDGET_EXCEEDED',
])

function describeCadence(seconds: number): string {
  if (seconds % 86_400 === 0) return `every ${seconds / 86_400} day(s)`
  if (seconds % 3_600 === 0) return `every ${seconds / 3_600} hour(s)`
  if (seconds % 60 === 0) return `every ${seconds / 60} minute(s)`
  return `every ${seconds} seconds`
}

type RunSummary = { status: string }

/**
 * Health from evidence only. A routine that is disabled, or has never produced a run, has not been
 * measured: that is `unknown`, never `ok`.
 */
export function routineHealth(input: {
  enabled: boolean
  intervalSeconds: number
  nextRunAt: Date | null
  lastSkipReason: string | null
  latestRun: RunSummary | null
  now: Date
}): { health: 'ok' | 'attention' | 'unknown'; reason: string } {
  if (!input.enabled) {
    return { health: 'unknown', reason: 'The routine is disabled, so nothing is being measured.' }
  }
  if (input.lastSkipReason && BLOCKING_SKIP_REASONS.has(input.lastSkipReason)) {
    return {
      health: 'attention',
      reason: `The scheduler last skipped it: ${input.lastSkipReason}.`,
    }
  }
  const overdueMs = 2 * input.intervalSeconds * 1000 + 5 * 60_000
  if (input.nextRunAt && input.now.getTime() - input.nextRunAt.getTime() > overdueMs) {
    return {
      health: 'attention',
      reason: 'It is well past its next run, so the scheduler may not be dispatching it.',
    }
  }
  if (!input.latestRun) {
    return { health: 'unknown', reason: 'It is enabled but has not produced a run yet.' }
  }
  if (input.latestRun.status === 'FAILED') {
    return { health: 'attention', reason: 'The latest run failed.' }
  }
  if (input.latestRun.status === 'COMPLETED') {
    return { health: 'ok', reason: 'The latest run completed and the schedule is on time.' }
  }
  return { health: 'unknown', reason: `The latest run is ${input.latestRun.status}, not finished.` }
}

const routinesGetRunStatus: OperatorReadTool = {
  name: 'routines.get_run_status',
  capability: 'routines:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['routines.get_run_status'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const routine = await context.database.agentRoutine.findFirst({
      where: { id: input.routineId, tenantId: input.tenantId },
      select: {
        id: true,
        venueId: true,
        routineKey: true,
        intervalSeconds: true,
        maxAttempts: true,
        maxRunsPerDay: true,
        perRunBudgetE8Usd: true,
        dailyBudgetE8Usd: true,
        budgetCents: true,
        budgetCurrency: true,
        budgetPeriod: true,
        estimatedRunCostCents: true,
        stopRules: true,
        stoppedAt: true,
        stopReason: true,
        enabled: true,
        nextRunAt: true,
        lastRunAt: true,
        lastSkipReason: true,
        createdBy: true,
        updatedAt: true,
        agentIdentity: { select: { id: true, name: true, enabled: true } },
      },
    })
    if (!routine) throw new OperatorNotFoundError()
    const dayStart = new Date(Math.floor(context.now.getTime() / DAY_MS) * DAY_MS)
    const [dispatches, runsToday] = await Promise.all([
      context.database.agentRoutineDispatch.findMany({
        where: { tenantId: input.tenantId, routineId: routine.id },
        orderBy: [{ scheduledFor: 'desc' }, { id: 'desc' }],
        take: 10,
        select: {
          agentRunId: true,
          scheduledFor: true,
          agentRun: {
            select: { status: true, errorCode: true, startedAt: true, completedAt: true },
          },
        },
      }),
      context.database.agentRoutineDispatch.count({
        where: {
          tenantId: input.tenantId,
          routineId: routine.id,
          scheduledFor: { gte: dayStart },
        },
      }),
    ])
    const recentRuns = dispatches.map((dispatch) => ({
      runId: dispatch.agentRunId,
      scheduledFor: dispatch.scheduledFor.toISOString(),
      runStatus: dispatch.agentRun.status,
      errorCode: dispatch.agentRun.errorCode,
      startedAt: dispatch.agentRun.startedAt?.toISOString() ?? null,
      completedAt: dispatch.agentRun.completedAt?.toISOString() ?? null,
    }))
    const latest = recentRuns[0] ?? null
    const verdict = routineHealth({
      enabled: routine.enabled,
      intervalSeconds: routine.intervalSeconds,
      nextRunAt: routine.nextRunAt,
      lastSkipReason: routine.lastSkipReason,
      latestRun: latest ? { status: latest.runStatus } : null,
      now: context.now,
    })
    const legacyBudgetsPresent =
      routine.perRunBudgetE8Usd !== null || routine.dailyBudgetE8Usd !== null
    const budgetConfig = routineBudgetOf(routine)
    let budget: {
      amountCents: number
      currency: string
      period: 'DAY' | 'WEEK' | 'MONTH'
      estimatedRunCostCents: number
      periodStart: string
      periodEnd: string
      spentCents: number
      remainingCents: number
    } | null = null
    if (budgetConfig) {
      const bounds = budgetPeriodBounds(budgetConfig.budgetPeriod, context.now)
      const usage = await context.database.agentRoutineBudgetUsage.findFirst({
        where: {
          tenantId: input.tenantId,
          routineId: routine.id,
          period: budgetConfig.budgetPeriod,
          periodStart: bounds.start,
        },
        select: { spentCents: true },
      })
      const spentCents = usage?.spentCents ?? 0
      budget = {
        amountCents: budgetConfig.budgetCents,
        currency: budgetConfig.budgetCurrency,
        period: budgetConfig.budgetPeriod,
        estimatedRunCostCents: budgetConfig.estimatedRunCostCents,
        periodStart: bounds.start.toISOString(),
        periodEnd: bounds.end.toISOString(),
        spentCents,
        remainingCents: Math.max(budgetConfig.budgetCents - spentCents, 0),
      }
    }
    const parsedRules = RoutineStopRules.safeParse(routine.stopRules ?? {})
    const rules = parsedRules.success ? parsedRules.data : {}
    const hasStopRules =
      rules.subject !== undefined || rules.maxReminders !== undefined || rules.endsAt !== undefined
    return {
      tenantId: input.tenantId,
      venueId: routine.venueId,
      routineId: routine.id,
      routineKey: operatorUntrustedText(routine.routineKey),
      owner: {
        createdBy: routine.createdBy.slice(0, 191),
        agentIdentityId: routine.agentIdentity.id,
        agentName: operatorUntrustedText(routine.agentIdentity.name),
        agentEnabled: routine.agentIdentity.enabled,
      },
      version: routine.updatedAt.toISOString(),
      state: routine.enabled ? ('enabled' as const) : ('disabled' as const),
      schedule: {
        kind: 'interval' as const,
        intervalSeconds: routine.intervalSeconds,
        cadence: describeCadence(routine.intervalSeconds),
        timeZone: null,
        nextRunAt: routine.nextRunAt?.toISOString() ?? null,
        lastRunAt: routine.lastRunAt?.toISOString() ?? null,
      },
      lastResult: latest,
      lastSkipReason: routine.lastSkipReason ? operatorUntrustedText(routine.lastSkipReason) : null,
      limits: {
        maxRunsPerDay: routine.maxRunsPerDay,
        runsTodayUtc: runsToday,
        maxAttempts: routine.maxAttempts,
        cost: {
          enforced: budget !== null,
          perRunBudgetE8Usd: routine.perRunBudgetE8Usd?.toString() ?? null,
          dailyBudgetE8Usd: routine.dailyBudgetE8Usd?.toString() ?? null,
          budget,
          note: legacyBudgetsPresent
            ? 'Legacy E8 budget values are stored but not enforced; the scheduler skips a routine that carries one.'
            : budget
              ? 'Each run reserves its estimated cost before it starts; a run that does not fit in the remaining period budget is refused with BUDGET_EXCEEDED. Estimates are conservative ceilings, not measured spend.'
              : 'No dollar budget is set. The run count per day is the only cost limit.',
        },
        stopRules: {
          subject: rules.subject ? { kind: rules.subject.kind, id: rules.subject.id } : null,
          maxReminders: rules.maxReminders ?? null,
          endsAt: rules.endsAt ? new Date(rules.endsAt).toISOString() : null,
          stoppedAt: routine.stoppedAt?.toISOString() ?? null,
          stopReason: routine.stopReason ?? null,
        },
      },
      stopConditions: [
        {
          key: 'disabled',
          active: !routine.enabled,
          detail: 'A disabled routine is never dispatched and has no next run.',
        },
        {
          key: 'agent_identity_disabled',
          active: !routine.agentIdentity.enabled,
          detail: 'The scheduler skips a routine whose agent identity is disabled.',
        },
        {
          key: 'daily_run_limit',
          active: runsToday >= routine.maxRunsPerDay,
          detail: `At most ${routine.maxRunsPerDay} runs per UTC day.`,
        },
        {
          key: 'serial_run_fence',
          active: latest ? ACTIVE_RUN_STATUSES.includes(latest.runStatus) : false,
          detail: 'A routine does not start a run while its previous run is unfinished.',
        },
        {
          key: 'stopped_by_rule',
          active: Boolean(routine.stoppedAt),
          detail: routine.stopReason
            ? `The routine stopped itself: ${routine.stopReason}. Enabling it again re-checks the rules.`
            : 'Before every run the scheduler checks stop rules (client reply recorded, request resolved or cancelled, venue or customer offboarded, reminder count, end date) and stops the routine if one is met.',
        },
        {
          key: 'budget_exceeded',
          active: budget ? routine.lastSkipReason === 'BUDGET_EXCEEDED' : null,
          detail: budget
            ? 'A run is refused, with nothing started, when its estimated cost does not fit in the remaining budget for the period.'
            : 'No dollar budget is set on this routine.',
        },
        {
          key: 'stop_rules_configured',
          active: hasStopRules,
          detail:
            'Whether this routine carries its own stop rules. Offboarding, suspension and customer churn are always checked.',
        },
      ],
      recentRuns,
      health: verdict.health,
      healthReason: verdict.reason,
    }
  },
}

export const routineReadTools: readonly OperatorReadTool[] = [routinesList, routinesGetRunStatus]
