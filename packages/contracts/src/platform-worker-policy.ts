import { z } from 'zod'

const Identifier = z.string().trim().min(1).max(191)

export const PlatformWorkerPolicyCapability = z.enum(['founder-decisions:read'])
export type PlatformWorkerPolicyCapability = z.infer<typeof PlatformWorkerPolicyCapability>

/** Constructed only after a server-side credential verification. */
export const VerifiedPlatformWorkerPolicyCredential = z
  .object({
    credentialId: Identifier,
    workerId: Identifier,
    capabilities: z.array(PlatformWorkerPolicyCapability).min(1).max(1),
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
