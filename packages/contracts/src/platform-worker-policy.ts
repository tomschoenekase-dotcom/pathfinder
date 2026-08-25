import { z } from 'zod'

const Identifier = z.string().trim().min(1).max(191)

export const PlatformWorkerPolicyCapability = z.enum([
  'founder-decisions:read',
  'founder-operating-view:read',
  'founder-directive-tasks:read',
  'founder-directive-tasks:propose',
  'founder-directive-tasks:materialize',
  'operations-readiness:read',
  'release-evidence:read',
  'release-evidence:record',
])
export type PlatformWorkerPolicyCapability = z.infer<typeof PlatformWorkerPolicyCapability>

/** Constructed only after a server-side credential verification. */
export const VerifiedPlatformWorkerPolicyCredential = z
  .object({
    credentialId: Identifier,
    workerId: Identifier,
    capabilities: z
      .array(PlatformWorkerPolicyCapability)
      .min(1)
      .max(PlatformWorkerPolicyCapability.options.length),
  })
  .strict()
export type VerifiedPlatformWorkerPolicyCredential = z.infer<
  typeof VerifiedPlatformWorkerPolicyCredential
>

export const PlatformWorkerFounderDecisionRequest = z
  .object({
    keys: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.keys).size !== value.keys.length) {
      context.addIssue({ code: 'custom', path: ['keys'], message: 'Decision keys must be unique.' })
    }
  })
export type PlatformWorkerFounderDecisionRequest = z.infer<
  typeof PlatformWorkerFounderDecisionRequest
>

/** A bounded platform-wide operating snapshot. No cursor advances or mutations are accepted. */
export const PlatformWorkerFounderOperatingViewRequest = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict()
export type PlatformWorkerFounderOperatingViewRequest = z.infer<
  typeof PlatformWorkerFounderOperatingViewRequest
>

/** No queue selector is accepted: the response is one bounded platform inventory. */
export const PlatformWorkerOperationsReadinessRequest = z.object({}).strict()
export type PlatformWorkerOperationsReadinessRequest = z.infer<
  typeof PlatformWorkerOperationsReadinessRequest
>

export const FOUNDER_DIRECTIVE_TASK_MATERIALIZE_ACTION =
  'torchiko.founder-directive.materialize-task' as const

const FounderDirectiveProspectScope = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ALL') }).strict(),
  z
    .object({
      mode: z.literal('TERRITORIES'),
      territoryIds: z
        .array(Identifier)
        .min(1)
        .max(100)
        .refine((values) => new Set(values).size === values.length, {
          message: 'Prospect territory IDs must be unique.',
        }),
    })
    .strict(),
])

export const PlatformWorkerFounderDirectiveTaskRequest = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('read'),
      limit: z.number().int().min(1).max(50).default(20),
      status: z
        .enum(['AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'MATERIALIZED'])
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('propose'),
      operationId: z.string().uuid(),
      founderOperatingExchangeId: z.string().uuid(),
      expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
      tenantId: Identifier,
      venueId: Identifier,
      agentIdentityId: Identifier,
      proposedPrompt: z.string().trim().min(1).max(10_000),
      rationale: z.string().trim().min(1).max(2000),
      riskCategory: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
      constraints: z
        .array(z.string().trim().min(1).max(500))
        .max(20)
        .refine((values) => new Set(values).size === values.length, {
          message: 'Directive task constraints must be unique.',
        })
        .default([]),
      prospectScope: FounderDirectiveProspectScope.optional(),
      expiresAt: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('materialize'),
      operationId: z.string().uuid(),
      requestId: z.string().uuid(),
      expectedApprovalDecisionId: Identifier,
    })
    .strict(),
])
export type PlatformWorkerFounderDirectiveTaskRequest = z.infer<
  typeof PlatformWorkerFounderDirectiveTaskRequest
>
