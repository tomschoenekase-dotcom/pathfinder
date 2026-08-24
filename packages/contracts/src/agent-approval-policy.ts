import { z } from 'zod'

export const OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION = 'pathfinder.create_update_draft' as const
export const OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY = 'updates:draft' as const
export const SUPPORT_REQUEST_DRAFT_POLICY_ACTION = 'pathfinder.create_support_draft' as const
export const SUPPORT_REQUEST_DRAFT_POLICY_CAPABILITY = 'support:draft' as const
export const INTAKE_NOTES_PROPOSAL_POLICY_ACTION =
  'pathfinder.create_intake_notes_proposal' as const
export const INTAKE_NOTES_PROPOSAL_POLICY_CAPABILITY = 'intake:draft' as const
export const WEEKLY_REPORT_DRAFT_POLICY_ACTION = 'pathfinder.generate_weekly_report_draft' as const
export const WEEKLY_REPORT_DRAFT_POLICY_CAPABILITY = 'reports:draft' as const

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

/** Reviewed bounds for machine-authored onboarding notes. The proposal remains
 * awaiting review and cannot extract, create a package, apply, or publish. */
export const IntakeNotesProposalPolicyConstraints = z
  .object({
    contractVersion: z.literal(1),
    effect: z.literal('PROPOSAL_ONLY'),
    allowedKinds: z.tuple([z.literal('NOTES')]),
    maxNotesChars: z.number().int().min(1).max(20_000),
  })
  .strict()

export type IntakeNotesProposalPolicyConstraints = z.infer<
  typeof IntakeNotesProposalPolicyConstraints
>

export const IntakeNotesProposalPolicyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    kind: z.literal('NOTES'),
    notes: z.string().trim().min(1).max(20_000),
  })
  .strict()

export type IntakeNotesProposalPolicyParameters = z.infer<
  typeof IntakeNotesProposalPolicyParameters
>

export function defaultIntakeNotesProposalPolicyConstraints(): IntakeNotesProposalPolicyConstraints {
  return {
    contractVersion: 1,
    effect: 'PROPOSAL_ONLY',
    allowedKinds: ['NOTES'],
    maxNotesChars: 20_000,
  }
}

/** Reviewed bounds for internal weekly-report generation. Generation can consume
 * AI budget, but the resulting report always remains a non-client-visible draft. */
export const WeeklyReportDraftPolicyConstraints = z
  .object({
    contractVersion: z.literal(1),
    effect: z.literal('DRAFT_GENERATION_ONLY'),
    maxTitleChars: z.number().int().min(1).max(200),
    maxRangeDays: z.number().int().min(1).max(31),
  })
  .strict()

export type WeeklyReportDraftPolicyConstraints = z.infer<typeof WeeklyReportDraftPolicyConstraints>

export const WeeklyReportDraftPolicyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    weekStart: z.string().datetime(),
    weekEnd: z.string().datetime(),
    title: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine((value) => new Date(value.weekEnd) >= new Date(value.weekStart), {
    path: ['weekEnd'],
    message: 'Weekly report end must not precede its start.',
  })

export type WeeklyReportDraftPolicyParameters = z.infer<typeof WeeklyReportDraftPolicyParameters>

export function defaultWeeklyReportDraftPolicyConstraints(): WeeklyReportDraftPolicyConstraints {
  return {
    contractVersion: 1,
    effect: 'DRAFT_GENERATION_ONLY',
    maxTitleChars: 200,
    maxRangeDays: 8,
  }
}
