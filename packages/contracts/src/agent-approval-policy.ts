import { z } from 'zod'

export const OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION = 'pathfinder.create_update_draft' as const
export const OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY = 'updates:draft' as const

/**
 * Reviewed bounds for the first policy-backed action class. The action remains
 * draft-only; these limits cannot authorize publication or widen venue scope.
 */
export const OperationalUpdateDraftPolicyConstraints = z
  .object({
    contractVersion: z.literal(1),
    effect: z.literal('DRAFT_ONLY'),
    allowedUpdateTypes: z.tuple([z.literal('GENERAL_NOTICE')]),
    allowedSeverities: z.tuple([z.literal('INFO')]),
    allowedPriorities: z.tuple([z.literal('NORMAL')]),
    maxTitleChars: z.number().int().min(1).max(160),
    maxBodyChars: z.number().int().min(1).max(4000),
  })
  .strict()

export type OperationalUpdateDraftPolicyConstraints = z.infer<
  typeof OperationalUpdateDraftPolicyConstraints
>

export const OperationalUpdateDraftPolicyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    updateType: z.literal('GENERAL_NOTICE'),
    severity: z.literal('INFO'),
    priority: z.literal('NORMAL'),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(4000),
    startsAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .refine((value) => new Date(value.expiresAt) > new Date(value.startsAt), {
    path: ['expiresAt'],
    message: 'Operational update expiry must follow its start time.',
  })

export type OperationalUpdateDraftPolicyParameters = z.infer<
  typeof OperationalUpdateDraftPolicyParameters
>

export function defaultOperationalUpdateDraftPolicyConstraints(): OperationalUpdateDraftPolicyConstraints {
  return {
    contractVersion: 1,
    effect: 'DRAFT_ONLY',
    allowedUpdateTypes: ['GENERAL_NOTICE'],
    allowedSeverities: ['INFO'],
    allowedPriorities: ['NORMAL'],
    maxTitleChars: 160,
    maxBodyChars: 4000,
  }
}
