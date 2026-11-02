import { z } from 'zod'

// Registry membership and workload/model compatibility are checked again by the canonical API
// schema and database action. Contracts do not depend on the AI implementation package.
export const OperatorAiWorkloadId = z.string().trim().min(1).max(120)
export const OperatorAiWorkloadValues = z
  .object({
    primaryModelKey: OperatorAiWorkloadId.optional(),
    fallback: z
      .object({ enabled: z.boolean(), modelKeys: z.array(OperatorAiWorkloadId).max(3) })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
    maxAttempts: z.number().int().min(1).max(5).optional(),
    maxOutputTokens: z.number().int().min(1).max(32_000).nullable().optional(),
    requestBudgetCeilingE8Usd: z.string().regex(/^\d+$/u).nullable().optional(),
  })
  .strict()

export const OperatorAiWorkloadReadOutput = z
  .object({
    workloadId: OperatorAiWorkloadId,
    availableWorkloads: z.array(OperatorAiWorkloadId).max(100),
    providerExecution: z.literal(false),
    stagedControlPlane: z.literal(true),
    effective: z
      .object({
        primaryModelKey: OperatorAiWorkloadId,
        provider: z.string().max(120),
        model: z.string().max(200),
        fallback: z
          .object({ enabled: z.boolean(), modelKeys: z.array(OperatorAiWorkloadId).max(3) })
          .strict(),
        timeoutMs: z.number().int(),
        maxAttempts: z.number().int(),
        maxOutputTokens: z.number().int().nullable(),
        requestBudgetCeilingE8Usd: z.string().nullable(),
        sources: z.record(z.string(), z.string()),
      })
      .strict(),
    venueOverride: z
      .object({
        revision: z.number().int().positive(),
        enabled: z.boolean(),
        isTombstone: z.boolean(),
        values: OperatorAiWorkloadValues,
        unsafeChangesEnabled: z.boolean(),
      })
      .strict()
      .nullable(),
    modelOptions: z
      .array(
        z
          .object({
            key: OperatorAiWorkloadId,
            provider: z.string().max(120),
            model: z.string().max(200),
            available: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
