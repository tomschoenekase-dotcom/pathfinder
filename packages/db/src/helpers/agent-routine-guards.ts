import {
  ROUTINE_BUDGET_EXCEEDED,
  RoutineStopRules,
  type RoutineBudgetPeriod,
  type RoutineStopReason,
} from '@pathfinder/contracts'

import type { db } from '../client'

/**
 * Run-time guards for recurring routines: reminder stop rules and dollar budgets. They live in
 * `packages/db` (not in the worker or the API) so the dispatcher, the operator proposal path and
 * any later worker share one implementation, and so a worker never imports `@pathfinder/api`.
 *
 * Both guards run inside the dispatcher's per-routine advisory-locked transaction, before any
 * AgentRun or other effect is created.
 */

export type RoutineGuardClient = Pick<
  typeof db,
  | 'tenant'
  | 'billingAccount'
  | 'offboardingPlan'
  | 'supportRequest'
  | 'supportMessage'
  | 'clientInboundReply'
  | 'agentRoutine'
  | 'agentRoutineDispatch'
  | 'agentRoutineBudgetUsage'
>

export type RoutineGuardInput = {
  id: string
  tenantId: string
  venueId: string
  createdAt: Date
  stopRules: unknown
}

/** Plan states in which a venue's access is being, or has been, revoked. */
const OFFBOARDING_STATES = ['REVOKING', 'EXPORT_READY', 'COMPLETED'] as const
const CHURNED_BILLING_STATES = ['CANCELED', 'ENDED'] as const

/**
 * Returns why the routine must stop now, or null to keep going. Order matters only for which reason
 * is reported first: customer-level reasons, then the routine's own limits, then its subject.
 * Reads only; recording the stop is `recordRoutineStop`.
 */
export async function evaluateRoutineStopRules(
  client: RoutineGuardClient,
  routine: RoutineGuardInput,
  now: Date,
): Promise<RoutineStopReason | 'INVALID_STOP_RULES' | null> {
  const parsed = RoutineStopRules.safeParse(routine.stopRules ?? {})
  // Stored rules are validated on the way in. If one is unreadable, stopping is the safe failure.
  if (!parsed.success) return 'INVALID_STOP_RULES'
  const rules = parsed.data
  const { tenantId, venueId } = routine

  const tenant = await client.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  })
  if (!tenant || tenant.status === 'SUSPENDED') return 'TENANT_SUSPENDED'

  const billing = await client.billingAccount.findFirst({
    where: { tenantId },
    select: { status: true },
  })
  if (billing && (CHURNED_BILLING_STATES as readonly string[]).includes(billing.status)) {
    return 'CUSTOMER_CHURNED'
  }

  const offboarding = await client.offboardingPlan.findFirst({
    where: {
      tenantId,
      status: { in: [...OFFBOARDING_STATES] },
      venueTargets: { some: { tenantId, venueId } },
    },
    select: { id: true },
  })
  if (offboarding) return 'VENUE_OFFBOARDED'

  if (rules.endsAt !== undefined && now.getTime() >= new Date(rules.endsAt).getTime()) {
    return 'END_DATE_REACHED'
  }
  if (rules.maxReminders !== undefined) {
    const sent = await client.agentRoutineDispatch.count({
      where: { tenantId, venueId, routineId: routine.id },
    })
    if (sent >= rules.maxReminders) return 'MAX_REMINDERS_REACHED'
  }

  const subject = rules.subject
  if (subject?.kind === 'SUPPORT_REQUEST') {
    const request = await client.supportRequest.findFirst({
      where: { id: subject.id, tenantId, venueId },
      select: { status: true },
    })
    if (!request) return 'SUBJECT_MISSING'
    if (request.status === 'COMPLETED') return 'REQUEST_RESOLVED'
    if (request.status === 'CANCELLED') return 'REQUEST_CANCELLED'
    const reply = await client.supportMessage.findFirst({
      where: {
        tenantId,
        venueId,
        supportRequestId: subject.id,
        authorKind: 'CLIENT',
        createdAt: { gt: routine.createdAt },
      },
      select: { id: true },
    })
    if (reply) return 'TARGET_REPLIED'
    const emailReply = await client.clientInboundReply.findFirst({
      where: {
        tenantId,
        venueId,
        supportRequestId: subject.id,
        receivedAt: { gt: routine.createdAt },
      },
      select: { id: true },
    })
    if (emailReply) return 'TARGET_REPLIED'
  }
  if (subject?.kind === 'PROSPECT_CONTACT') {
    // Legacy or directly persisted definitions are stopped without reading global CRM state.
    // A prospect contact has no tenant relation that can prove this routine may observe it.
    return 'SUBJECT_MISSING'
  }
  return null
}

/**
 * Stops the routine and records the reason on it. The compare-and-set on `stoppedAt IS NULL` makes
 * a re-run a no-op: exactly one caller sees `recorded: true` and writes the audit row.
 */
export async function recordRoutineStop(
  client: Pick<RoutineGuardClient, 'agentRoutine'>,
  routine: { id: string; tenantId: string; venueId: string },
  reason: string,
  now: Date,
): Promise<{ recorded: boolean }> {
  const changed = await client.agentRoutine.updateMany({
    where: {
      id: routine.id,
      tenantId: routine.tenantId,
      venueId: routine.venueId,
      stoppedAt: null,
    },
    data: {
      enabled: false,
      nextRunAt: null,
      stoppedAt: now,
      stopReason: reason,
      lastSkipReason: reason,
    },
  })
  return { recorded: changed.count === 1 }
}

// ---------------------------------------------------------------------------
// Dollar budgets
// ---------------------------------------------------------------------------

export type RoutineBudgetConfig = {
  budgetCents: number
  budgetCurrency: string
  budgetPeriod: RoutineBudgetPeriod
  estimatedRunCostCents: number
}

/** The budget columns are all-or-none (database CHECK); null means the routine has no budget. */
export function routineBudgetOf(routine: {
  budgetCents: number | null
  budgetCurrency: string | null
  budgetPeriod: RoutineBudgetPeriod | null
  estimatedRunCostCents: number | null
}): RoutineBudgetConfig | null {
  if (
    typeof routine.budgetCents !== 'number' ||
    typeof routine.budgetCurrency !== 'string' ||
    typeof routine.budgetPeriod !== 'string' ||
    typeof routine.estimatedRunCostCents !== 'number'
  ) {
    return null
  }
  return {
    budgetCents: routine.budgetCents,
    budgetCurrency: routine.budgetCurrency,
    budgetPeriod: routine.budgetPeriod,
    estimatedRunCostCents: routine.estimatedRunCostCents,
  }
}

/** UTC period bounds: a day, an ISO week starting Monday, or a calendar month. */
export function budgetPeriodBounds(period: RoutineBudgetPeriod, now: Date) {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const day = now.getUTCDate()
  if (period === 'DAY') {
    return {
      start: new Date(Date.UTC(year, month, day)),
      end: new Date(Date.UTC(year, month, day + 1)),
    }
  }
  if (period === 'WEEK') {
    const sinceMonday = (now.getUTCDay() + 6) % 7
    return {
      start: new Date(Date.UTC(year, month, day - sinceMonday)),
      end: new Date(Date.UTC(year, month, day - sinceMonday + 7)),
    }
  }
  return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) }
}

export type BudgetReservation =
  | { ok: true; reservedCents: number; remainingCents: number }
  | { ok: false; reason: typeof ROUTINE_BUDGET_EXCEEDED; remainingCents: number }

/**
 * Reserves one run's conservative estimate against the current period, atomically.
 *
 * The decision is a single conditional UPDATE (`spent <= budget - estimate`), so two schedulers that
 * race can never both fit the last slot: the second re-evaluates after the first commits. The
 * ledger's CHECK (`spent_cents <= budget_cents`) is the database-level backstop for any other
 * writer. Refusal writes nothing, so a refused run leaves no partial effect. The reservation is
 * part of the caller's transaction, so if the run fails to materialize the spend rolls back.
 */
export async function reserveAgentRoutineBudget(
  client: Pick<RoutineGuardClient, 'agentRoutineBudgetUsage'>,
  routine: { id: string; tenantId: string; venueId: string } & RoutineBudgetConfig,
  now: Date,
): Promise<BudgetReservation> {
  const { start, end } = budgetPeriodBounds(routine.budgetPeriod, now)
  const key = {
    tenantId: routine.tenantId,
    venueId: routine.venueId,
    routineId: routine.id,
    period: routine.budgetPeriod,
    periodStart: start,
  }
  // Period rollover is just a new ledger row; concurrent first-writers collapse on the unique key.
  await client.agentRoutineBudgetUsage.createMany({
    data: [
      {
        ...key,
        periodEnd: end,
        currency: routine.budgetCurrency,
        budgetCents: routine.budgetCents,
      },
    ],
    skipDuplicates: true,
  })
  // A budget edited mid-period is picked up only in the same currency. Existing spend cannot be
  // reinterpreted in a different currency; that change waits for the next period.
  await client.agentRoutineBudgetUsage.updateMany({
    where: {
      ...key,
      currency: routine.budgetCurrency,
      spentCents: { lte: routine.budgetCents },
      budgetCents: { not: routine.budgetCents },
    },
    data: { budgetCents: routine.budgetCents },
  })
  const reserved = await client.agentRoutineBudgetUsage.updateMany({
    where: {
      ...key,
      currency: routine.budgetCurrency,
      spentCents: { lte: routine.budgetCents - routine.estimatedRunCostCents },
    },
    data: {
      spentCents: { increment: routine.estimatedRunCostCents },
      runCount: { increment: 1 },
    },
  })
  const row = await client.agentRoutineBudgetUsage.findFirst({
    where: key,
    select: { spentCents: true, currency: true },
  })
  const spent = row?.spentCents ?? 0
  const remainingCents =
    row && row.currency !== routine.budgetCurrency ? 0 : Math.max(routine.budgetCents - spent, 0)
  if (reserved.count === 1) {
    return { ok: true, reservedCents: routine.estimatedRunCostCents, remainingCents }
  }
  return { ok: false, reason: ROUTINE_BUDGET_EXCEEDED, remainingCents }
}
