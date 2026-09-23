import { z } from 'zod'

import {
  AI_CENTRAL_MODEL_REGISTRY,
  modelIsSelectableForWorkload,
  type AiWorkloadId,
} from '@pathfinder/ai'

export const venueInputSchema = z
  .object({ tenantId: z.string().min(1).max(128), venueId: z.string().min(1).max(128) })
  .strict()

export const workloadIds = Object.keys(AI_CENTRAL_MODEL_REGISTRY).sort() as [
  AiWorkloadId,
  ...AiWorkloadId[],
]
const workloadIdSchema = z.enum(workloadIds)
export const scopeSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('WORKLOAD'), workloadId: workloadIdSchema }).strict(),
  z
    .object({
      level: z.literal('CLIENT'),
      tenantId: z.string().min(1).max(128),
      workloadId: workloadIdSchema,
    })
    .strict(),
  z
    .object({
      level: z.literal('VENUE'),
      tenantId: z.string().min(1).max(128),
      venueId: z.string().min(1).max(128),
      workloadId: workloadIdSchema,
    })
    .strict(),
])
const valuesSchema = z
  .object({
    primaryModelKey: workloadIdSchema.optional(),
    fallback: z
      .object({ enabled: z.boolean(), modelKeys: z.array(workloadIdSchema).max(3) })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
    maxAttempts: z.number().int().min(1).max(5).optional(),
    maxOutputTokens: z.number().int().min(1).max(32_000).nullable().optional(),
    requestBudgetCeilingE8Usd: z.string().regex(/^\d+$/u).nullable().optional(),
  })
  .strict()

export const saveInputSchema = z
  .object({
    scope: scopeSchema,
    expectedRevision: z.number().int().positive().nullable(),
    enabled: z.boolean(),
    values: valuesSchema,
    unsafeChangesEnabled: z.boolean().default(false),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .superRefine((input, context) => {
    const selectedKeys = [
      ...(input.values.primaryModelKey ? [input.values.primaryModelKey] : []),
      ...(input.values.fallback?.modelKeys ?? []),
    ]
    if (selectedKeys.some((key) => !modelIsSelectableForWorkload(key, input.scope.workloadId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['values'],
        message: 'AI model selection is not registered for this workload',
      })
    }
  })
