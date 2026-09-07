import { z } from 'zod'

const key = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
export const AgentWorkflowSupportedActionClassSchema = z.enum([
  'RUN_TERMINAL_WRITE',
  'APPROVAL_BACKED_DOMAIN_EFFECT',
  'AGENT_DELEGATION',
  'OPERATOR_QUESTION',
  'BILLING_PROPOSAL',
])

export const AgentWorkflowCanaryPolicySchema = z
  .object({
    numerator: z.number().int().min(0).max(10_000),
    denominator: z.number().int().min(1).max(10_000),
    salt: z.string().trim().min(16).max(191),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    maxSelectedRuns: z.number().int().min(1).max(100_000),
    eligibleRunTypes: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
    eligibleOperations: z.array(z.string().trim().min(1).max(191)).min(1).max(50),
    skippedBaseline: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('NO_WORKFLOW') }).strict(),
      z
        .object({
          kind: z.literal('PRIOR_VERSION'),
          workflowVersionId: z.string().uuid(),
          contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
        })
        .strict(),
    ]),
    supportedActionClasses: z.array(AgentWorkflowSupportedActionClassSchema).min(1).max(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.numerator > value.denominator)
      context.addIssue({
        code: 'custom',
        path: ['numerator'],
        message: 'Numerator cannot exceed denominator.',
      })
    if (Date.parse(value.endsAt) <= Date.parse(value.startsAt))
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'Canary end must follow start.',
      })
    for (const [path, values] of [
      ['eligibleRunTypes', value.eligibleRunTypes],
      ['eligibleOperations', value.eligibleOperations],
      ['supportedActionClasses', value.supportedActionClasses],
    ] as const)
      if (new Set(values).size !== values.length)
        context.addIssue({ code: 'custom', path: [path], message: 'Values must be unique.' })
  })

export const AgentWorkflowSelectionOutcomeSchema = z.enum([
  'SELECTED',
  'CANARY_SKIPPED_NO_WORKFLOW',
  'CANARY_SKIPPED_PRIOR_VERSION',
])

export const AgentWorkflowSelectionReasonSchema = z.enum([
  'HASH_SELECTED',
  'HASH_SKIPPED',
  'CAPACITY_EXHAUSTED',
  'NO_ACTIVE_WORKFLOW',
  'INELIGIBLE_RUN',
  'WINDOW_INACTIVE',
])

export const AgentWorkflowActivationRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    registryKey: key,
    workflowVersionId: z.string().uuid(),
    promotionAssessmentId: z.string().min(1).max(191),
    approvalDecisionId: z.string().min(1).max(191),
    expectedHeadRevision: z.number().int().min(0),
    canaryPolicy: AgentWorkflowCanaryPolicySchema,
    reason: z.string().trim().min(1).max(2000),
  })
  .strict()

export type AgentWorkflowCanaryPolicy = z.output<typeof AgentWorkflowCanaryPolicySchema>
export type AgentWorkflowSupportedActionClass = z.output<
  typeof AgentWorkflowSupportedActionClassSchema
>
