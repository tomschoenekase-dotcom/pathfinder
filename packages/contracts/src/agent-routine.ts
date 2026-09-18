import { z } from 'zod'

const Id = z.string().trim().min(1).max(191)

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
