import { z } from 'zod'

const Id = z.string().trim().min(1).max(191)

/**
 * What a recurring reminder or follow-up is waiting for. The subject is checked at run time, before
 * the routine does anything, so a routine stops itself when its purpose is met or has gone stale.
 */
export const RoutineStopSubject = z.union([
  /** A support request: stops when it is resolved, cancelled or the client replied. */
  z.object({ kind: z.literal('SUPPORT_REQUEST'), id: Id }).strict(),
  /** Reserved for a future platform-scoped routine. Tenant routine admission refuses this kind. */
  z.object({ kind: z.literal('PROSPECT_CONTACT'), id: Id }).strict(),
])
export type RoutineStopSubject = z.infer<typeof RoutineStopSubject>

export const RoutineStopRules = z
  .object({
    subject: RoutineStopSubject.optional(),
    /** Stop after this many dispatched runs. */
    maxReminders: z.number().int().min(1).max(1_000).optional(),
    /** Stop at or after this instant. */
    endsAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
export type RoutineStopRules = z.infer<typeof RoutineStopRules>

/** Why a routine stopped itself. Offboarding and churn are always checked, with or without rules. */
export const ROUTINE_STOP_REASONS = [
  'MAX_REMINDERS_REACHED',
  'END_DATE_REACHED',
  'TARGET_REPLIED',
  'REQUEST_RESOLVED',
  'REQUEST_CANCELLED',
  'SUBJECT_MISSING',
  'CONTACT_SUPPRESSED',
  'REPLY_RECORDED',
  'VENUE_OFFBOARDED',
  'TENANT_SUSPENDED',
  'CUSTOMER_CHURNED',
] as const
export type RoutineStopReason = (typeof ROUTINE_STOP_REASONS)[number]

/** The skip reason recorded when a run would exceed the routine's remaining dollar budget. */
export const ROUTINE_BUDGET_EXCEEDED = 'BUDGET_EXCEEDED'

export const ROUTINE_BUDGET_PERIODS = ['DAY', 'WEEK', 'MONTH'] as const
export type RoutineBudgetPeriod = (typeof ROUTINE_BUDGET_PERIODS)[number]

/**
 * A dollar budget in integer minor units for the spend a routine's runs can trigger (model spend
 * estimates or paid actions). `estimatedRunCostCents` is the conservative per-run ceiling that is
 * reserved before every run; a run that does not fit in the remaining budget is refused.
 */
export const RoutineBudget = z
  .object({
    amountCents: z.number().int().min(1).max(100_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    period: z.enum(ROUTINE_BUDGET_PERIODS),
    estimatedRunCostCents: z.number().int().min(1).max(100_000_000),
  })
  .strict()
  .refine((value) => value.estimatedRunCostCents <= value.amountCents, {
    path: ['estimatedRunCostCents'],
    message: 'A single run must fit inside the budget',
  })
export type RoutineBudget = z.infer<typeof RoutineBudget>

/**
 * A durable, deliberately-default-dark monitor definition. A routine only
 * becomes eligible after both a human enables it and the server runtime gate
 * is explicitly enabled.
 */
export const CreateAgentRoutineInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: Id,
    venueId: Id,
    routineKey: z.string().trim().min(1).max(191),
    agentIdentityId: Id,
    prompt: z.string().trim().min(1).max(10_000),
    requestedOperation: z.string().trim().min(1).max(191).default('routine_monitor'),
    intervalSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 60 * 60),
    // The first supported subset is one bridge attempt per dispatch. Retrying
    // a metered call needs a separate attempt-cost reservation ledger.
    maxAttempts: z.number().int().min(1).max(1).default(1),
    maxRunsPerDay: z.number().int().min(1).max(1_440).default(24),
    requiredWorkerRoles: z.array(Id).max(50).default([]),
    requiredWorkerCapabilities: z.array(Id).max(100).default([]),
    stopRules: RoutineStopRules.default({}),
    budget: RoutineBudget.nullable().default(null),
  })
  .strict()

export type CreateAgentRoutineInput = z.input<typeof CreateAgentRoutineInput>

export const SetAgentRoutineEnabledInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: Id,
    venueId: Id,
    routineId: Id,
    enabled: z.boolean(),
  })
  .strict()

export type SetAgentRoutineEnabledInput = z.input<typeof SetAgentRoutineEnabledInput>
