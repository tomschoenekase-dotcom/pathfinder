import { z } from 'zod'

const Identifier = z.string().trim().min(1).max(191)

export const PlatformWorkerPolicyCapability = z.enum([
  'founder-decisions:read',
  'founder-operating-view:read',
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
