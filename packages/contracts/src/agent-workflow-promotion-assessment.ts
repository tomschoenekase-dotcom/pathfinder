import { z } from 'zod'

export const AgentWorkflowPromotionAssessmentOutcomeSchema = z.enum([
  'EVIDENCE_READY_REVIEW_REQUIRED',
  'REJECTED_OVERFIT',
  'REJECTED_REGRESSION',
  'INCOMPLETE_EVIDENCE',
])

export const AgentWorkflowPromotionAssessmentDiagnosticsSchema = z
  .object({
    contractVersion: z.literal(1),
    interpretation: z.literal('evidence-only-no-activation'),
    development: z
      .object({
        validationId: z.string().min(1).max(191),
        caseCount: z.number().int().min(1).max(10_000),
        resolvedFailures: z.number().int().min(0).max(50),
        newFailures: z.number().int().min(0).max(50),
        missingResults: z.number().int().min(0).max(10_000),
        caseIdentityHash: z.string().regex(/^[0-9a-f]{64}$/u),
        latencyDeltaMs: z.number().int().nullable(),
        costDeltaE8Usd: z
          .string()
          .regex(/^-?\d+$/u)
          .nullable(),
      })
      .strict(),
    heldout: z
      .object({
        validationId: z.string().min(1).max(191),
        caseCount: z.number().int().min(1).max(10_000),
        resolvedFailures: z.number().int().min(0).max(50),
        newFailures: z.number().int().min(0).max(50),
        missingResults: z.number().int().min(0).max(10_000),
        caseIdentityHash: z.string().regex(/^[0-9a-f]{64}$/u),
        latencyDeltaMs: z.number().int().nullable(),
        costDeltaE8Usd: z
          .string()
          .regex(/^-?\d+$/u)
          .nullable(),
      })
      .strict(),
    disjointCaseSets: z.boolean(),
    targetImprovementObserved: z.boolean(),
    thresholdResolution: z.literal('UNRESOLVED'),
    autonomousPromotionEligible: z.literal(false),
    limitations: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
  })
  .strict()

export type AgentWorkflowPromotionAssessmentDiagnostics = z.output<
  typeof AgentWorkflowPromotionAssessmentDiagnosticsSchema
>
