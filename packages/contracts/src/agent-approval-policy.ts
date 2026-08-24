import { z } from 'zod'

export const OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION = 'pathfinder.create_update_draft' as const
export const OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY = 'updates:draft' as const
export const SUPPORT_REQUEST_DRAFT_POLICY_ACTION = 'pathfinder.create_support_draft' as const
export const SUPPORT_REQUEST_DRAFT_POLICY_CAPABILITY = 'support:draft' as const

export const SupportRequestDraftCategory = z.enum([
  'CONTENT_CORRECTION',
  'OPERATIONAL_UPDATE',
  'BRANDING',
  'EXPERIENCE_BEHAVIOR',
  'ACCESSIBILITY',
  'GENERAL',
])

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

/** Reviewed bounds for private support drafts. The draft is internal-only until
 * a human operator explicitly promotes it into the ordinary support workflow. */
export const SupportRequestDraftPolicyConstraints = z
  .object({
    contractVersion: z.literal(1),
    effect: z.literal('DRAFT_ONLY'),
    allowedCategories: z.tuple([
      z.literal('CONTENT_CORRECTION'),
      z.literal('OPERATIONAL_UPDATE'),
      z.literal('BRANDING'),
      z.literal('EXPERIENCE_BEHAVIOR'),
      z.literal('ACCESSIBILITY'),
      z.literal('GENERAL'),
    ]),
    maxSubjectChars: z.number().int().min(1).max(200),
    maxBodyChars: z.number().int().min(1).max(20_000),
  })
  .strict()

export type SupportRequestDraftPolicyConstraints = z.infer<
  typeof SupportRequestDraftPolicyConstraints
>

export const SupportRequestDraftPolicyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    category: SupportRequestDraftCategory,
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000),
  })
  .strict()

export type SupportRequestDraftPolicyParameters = z.infer<
  typeof SupportRequestDraftPolicyParameters
>

export function defaultSupportRequestDraftPolicyConstraints(): SupportRequestDraftPolicyConstraints {
  return {
    contractVersion: 1,
    effect: 'DRAFT_ONLY',
    allowedCategories: [
      'CONTENT_CORRECTION',
      'OPERATIONAL_UPDATE',
      'BRANDING',
      'EXPERIENCE_BEHAVIOR',
      'ACCESSIBILITY',
      'GENERAL',
    ],
    maxSubjectChars: 200,
    maxBodyChars: 20_000,
  }
}
