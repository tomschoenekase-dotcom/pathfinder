import { z } from 'zod'

export const OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION = 'pathfinder.create_update_draft' as const
export const OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY = 'updates:draft' as const
export const SUPPORT_REQUEST_DRAFT_POLICY_ACTION = 'pathfinder.create_support_draft' as const
export const SUPPORT_REQUEST_DRAFT_POLICY_CAPABILITY = 'support:draft' as const
export const SUPPORT_REQUEST_OPEN_POLICY_ACTION = 'pathfinder.open_support_request' as const
export const SUPPORT_REQUEST_OPEN_POLICY_CAPABILITY = 'support:open' as const
export const SUPPORT_TRIAGE_APPLY_ACTION = 'pathfinder.apply_support_triage' as const
export const SUPPORT_TRIAGE_APPLY_CAPABILITY = 'support:triage' as const
export const SUPPORT_INFORMATION_REQUEST_APPLY_ACTION =
  'pathfinder.apply_support_information_request' as const
export const SUPPORT_INFORMATION_REQUEST_CAPABILITY = 'support:request-information' as const
export const SUPPORT_COMPLETION_APPLY_ACTION = 'pathfinder.apply_support_completion' as const
export const SUPPORT_COMPLETION_CAPABILITY = 'support:complete' as const
export const SUPPORT_PACKAGE_DRAFT_APPLY_ACTION = 'pathfinder.apply_support_package_draft' as const
export const SUPPORT_PACKAGE_DRAFT_CAPABILITY = 'packages:draft' as const
export const SUPPORT_PACKAGE_APPROVAL_APPLY_ACTION =
  'pathfinder.apply_support_package_approval' as const
export const SUPPORT_PACKAGE_APPROVAL_CAPABILITY = 'packages:approve' as const
export const SUPPORT_PACKAGE_APPLICATION_APPLY_ACTION =
  'pathfinder.apply_support_package_application' as const
export const SUPPORT_PACKAGE_APPLICATION_CAPABILITY = 'packages:apply' as const
export const SUPPORT_INTERNAL_NOTE_POLICY_ACTION = 'pathfinder.add_support_internal_note' as const
export const SUPPORT_INTERNAL_NOTE_POLICY_CAPABILITY = 'support:note' as const
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

/** Reviewed authority for one internal lifecycle promotion. Issuers must cap
 * this policy at one use; it cannot add participants, messages, or execute work. */
export const SupportRequestOpenPolicyConstraints = z
  .object({
    contractVersion: z.literal(1),
    effect: z.literal('DRAFT_TO_OPEN_ONLY'),
    allowedFromStatuses: z.tuple([z.literal('DRAFT')]),
    allowedToStatuses: z.tuple([z.literal('OPEN')]),
  })
  .strict()

export type SupportRequestOpenPolicyConstraints = z.infer<
  typeof SupportRequestOpenPolicyConstraints
>

export const SupportRequestOpenPolicyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    fromStatus: z.literal('DRAFT'),
    toStatus: z.literal('OPEN'),
  })
  .strict()

export type SupportRequestOpenPolicyParameters = z.infer<typeof SupportRequestOpenPolicyParameters>

export function defaultSupportRequestOpenPolicyConstraints(): SupportRequestOpenPolicyConstraints {
  return {
    contractVersion: 1,
    effect: 'DRAFT_TO_OPEN_ONLY',
    allowedFromStatuses: ['DRAFT'],
    allowedToStatuses: ['OPEN'],
  }
}

/** Exact one-shot authority derived from an approved triage proposal. This is
 * intentionally not a reusable policy: every category and missing-information
 * change must match the reviewed proposal and request version. */
export const SupportTriageApplyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    category: SupportRequestDraftCategory,
    missingInformation: z
      .array(z.string().trim().min(1).max(500))
      .max(30)
      .refine((items) => new Set(items).size === items.length, 'Items must be unique'),
  })
  .strict()

export type SupportTriageApplyParameters = z.infer<typeof SupportTriageApplyParameters>

export const SupportTriageProposalApprovalSnapshot = z
  .object({
    contractVersion: z.literal(1),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    proposedCategory: SupportRequestDraftCategory,
    proposedMissingInformation: z
      .array(z.string().trim().min(1).max(500))
      .max(30)
      .refine((items) => new Set(items).size === items.length, 'Items must be unique'),
    supportRequestChanged: z.literal(false),
    clientActivityChanged: z.literal(false),
    customerContacted: z.literal(false),
    executionAuthorized: z.literal(false),
  })
  .strict()

export type SupportTriageProposalApprovalSnapshot = z.infer<
  typeof SupportTriageProposalApprovalSnapshot
>

/** Exact one-shot authority derived from an approved client information-request proposal.
 * The reviewed prompt and checklist are immutable; this is never reusable contact authority. */
export const SupportInformationRequestApplyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    fromStatus: z.enum(['OPEN', 'IN_REVIEW']),
    toStatus: z.literal('WAITING_FOR_CLIENT'),
    body: z.string().trim().min(1).max(20_000),
    missingInformation: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(30)
      .refine((items) => new Set(items).size === items.length, 'Items must be unique'),
  })
  .strict()

export type SupportInformationRequestApplyParameters = z.infer<
  typeof SupportInformationRequestApplyParameters
>

export const SupportInformationRequestProposalApprovalSnapshot = z
  .object({
    contractVersion: z.literal(1),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    fromStatus: z.enum(['OPEN', 'IN_REVIEW']),
    toStatus: z.literal('WAITING_FOR_CLIENT'),
    body: z.string().trim().min(1).max(20_000),
    missingInformation: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(30)
      .refine((items) => new Set(items).size === items.length, 'Items must be unique'),
    supportRequestChanged: z.literal(false),
    clientActivityChanged: z.literal(false),
    clientVisibleMessageCreated: z.literal(false),
    customerContacted: z.literal(false),
    externalDeliveryTriggered: z.literal(false),
    executionAuthorized: z.literal(false),
  })
  .strict()

export type SupportInformationRequestProposalApprovalSnapshot = z.infer<
  typeof SupportInformationRequestProposalApprovalSnapshot
>

/** Exact one-shot authority derived from an approved completion proposal. The
 * reviewed message and request version are immutable; this is never reusable
 * customer-contact or lifecycle authority. */
export const SupportCompletionApplyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    fromStatus: z.enum(['OPEN', 'IN_REVIEW']),
    toStatus: z.literal('COMPLETED'),
    body: z.string().trim().min(1).max(20_000),
  })
  .strict()

export type SupportCompletionApplyParameters = z.infer<typeof SupportCompletionApplyParameters>

export const SupportCompletionProposalApprovalSnapshot = z
  .object({
    contractVersion: z.literal(1),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    fromStatus: z.enum(['OPEN', 'IN_REVIEW']),
    toStatus: z.literal('COMPLETED'),
    body: z.string().trim().min(1).max(20_000),
    missingInformationCount: z.literal(0),
    supportRequestChanged: z.literal(false),
    clientActivityChanged: z.literal(false),
    clientVisibleMessageCreated: z.literal(false),
    customerContacted: z.literal(false),
    externalDeliveryTriggered: z.literal(false),
    executionAuthorized: z.literal(false),
  })
  .strict()

export type SupportCompletionProposalApprovalSnapshot = z.infer<
  typeof SupportCompletionProposalApprovalSnapshot
>

const SupportPackageDraftOperationCounts = z
  .object({
    venuePatch: z.boolean(),
    placeCreates: z.number().int().nonnegative(),
    placeUpdates: z.number().int().nonnegative(),
    placeDeletes: z.number().int().nonnegative(),
    knowledgeCreates: z.number().int().nonnegative(),
    knowledgeUpdates: z.number().int().nonnegative(),
    knowledgeDeletes: z.number().int().nonnegative(),
    total: z.number().int().positive().max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const total =
      (value.venuePatch ? 1 : 0) +
      value.placeCreates +
      value.placeUpdates +
      value.placeDeletes +
      value.knowledgeCreates +
      value.knowledgeUpdates +
      value.knowledgeDeletes
    if (total !== value.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['total'],
        message: 'Package operation total does not match its reviewed breakdown.',
      })
    }
  })

/** Exact one-shot authority derived from an approved support package-draft proposal.
 * Application may create and link one immutable V3 DRAFT only. It cannot approve,
 * apply, publish, roll back, contact the client, or change request status/triage. */
export const SupportPackageDraftApplyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    fromStatus: z.enum(['OPEN', 'IN_REVIEW']),
    draftKey: z.string().uuid(),
    payload: z.record(z.unknown()),
    proposalPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    operationCounts: SupportPackageDraftOperationCounts,
  })
  .strict()

export type SupportPackageDraftApplyParameters = z.infer<typeof SupportPackageDraftApplyParameters>

export const SupportPackageDraftProposalApprovalSnapshot = z
  .object({
    contractVersion: z.literal(1),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    fromStatus: z.enum(['OPEN', 'IN_REVIEW']),
    draftKey: z.string().uuid(),
    payload: z.record(z.unknown()),
    proposalPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    operationCounts: SupportPackageDraftOperationCounts,
    missingInformationCount: z.literal(0),
    packageDraftCreated: z.literal(false),
    packageLinked: z.literal(false),
    packageApproved: z.literal(false),
    packageApplied: z.literal(false),
    packagePublished: z.literal(false),
    supportRequestChanged: z.literal(false),
    clientActivityChanged: z.literal(false),
    customerContacted: z.literal(false),
    externalDeliveryTriggered: z.literal(false),
    executionAuthorized: z.literal(false),
  })
  .strict()

export type SupportPackageDraftProposalApprovalSnapshot = z.infer<
  typeof SupportPackageDraftProposalApprovalSnapshot
>

const SupportPackageApprovalHandoff = z
  .object({
    handoffId: z.string().trim().min(1).max(191),
    supportRequestId: z.string().trim().min(1).max(191),
    supportRequestVersion: z.number().int().positive(),
  })
  .strict()

const SupportPackageApprovalEvaluationEvidence = z
  .object({
    exactPackageRunIds: z.array(z.string().uuid()).max(20),
    truncated: z.boolean(),
    thresholdApplied: z.literal(false),
  })
  .strict()

/** Exact one-shot authority derived from a founder-reviewed package approval proposal.
 * It may move one unchanged support-linked package from DRAFT to APPROVED only. It
 * cannot apply, publish, revert, contact a customer, or change the support request. */
export const SupportPackageApprovalApplyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    packageId: z.string().trim().min(1).max(191),
    expectedUpdatedAt: z.string().datetime(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    baseDigest: z.string().regex(/^[a-f0-9]{64}$/),
    warningDigest: z.string().regex(/^[a-f0-9]{64}$/),
    supportHandoff: SupportPackageApprovalHandoff,
  })
  .strict()

export type SupportPackageApprovalApplyParameters = z.infer<
  typeof SupportPackageApprovalApplyParameters
>

export const SupportPackageApprovalProposalSnapshot = z
  .object({
    contractVersion: z.literal(1),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    packageId: z.string().trim().min(1).max(191),
    expectedUpdatedAt: z.string().datetime(),
    fromStatus: z.literal('DRAFT'),
    toStatus: z.literal('APPROVED'),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    baseDigest: z.string().regex(/^[a-f0-9]{64}$/),
    warningDigest: z.string().regex(/^[a-f0-9]{64}$/),
    warningCodes: z.array(z.string().trim().min(1).max(191)).max(500),
    supportHandoff: SupportPackageApprovalHandoff,
    evaluationEvidence: SupportPackageApprovalEvaluationEvidence,
    packageApproved: z.literal(false),
    packageApplied: z.literal(false),
    packagePublished: z.literal(false),
    supportRequestChanged: z.literal(false),
    customerContacted: z.literal(false),
    externalDeliveryTriggered: z.literal(false),
    executionAuthorized: z.literal(false),
  })
  .strict()

export type SupportPackageApprovalProposalSnapshot = z.infer<
  typeof SupportPackageApprovalProposalSnapshot
>

/** Exact one-shot authority derived from founder review of an already-approved package.
 * Execution mutates current venue content and may become visitor-visible immediately. */
export const SupportPackageApplicationApplyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    packageId: z.string().trim().min(1).max(191),
    expectedUpdatedAt: z.string().datetime(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    baseDigest: z.string().regex(/^[a-f0-9]{64}$/),
    warningDigest: z.string().regex(/^[a-f0-9]{64}$/),
    approvedAt: z.string().datetime(),
    approvedBy: z.string().trim().min(1).max(191),
    supportHandoff: SupportPackageApprovalHandoff,
  })
  .strict()

export type SupportPackageApplicationApplyParameters = z.infer<
  typeof SupportPackageApplicationApplyParameters
>

export const SupportPackageApplicationProposalSnapshot = z
  .object({
    contractVersion: z.literal(1),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    packageId: z.string().trim().min(1).max(191),
    expectedUpdatedAt: z.string().datetime(),
    fromStatus: z.literal('APPROVED'),
    toStatus: z.literal('APPLIED'),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    baseDigest: z.string().regex(/^[a-f0-9]{64}$/),
    warningDigest: z.string().regex(/^[a-f0-9]{64}$/),
    warningCodes: z.array(z.string().trim().min(1).max(191)).max(500),
    approvedAt: z.string().datetime(),
    approvedBy: z.string().trim().min(1).max(191),
    supportHandoff: SupportPackageApprovalHandoff,
    evaluationEvidence: SupportPackageApprovalEvaluationEvidence,
    currentContentMutation: z.literal(true),
    visitorVisibleChangePossible: z.literal(true),
    supportRequestChanged: z.literal(false),
    customerContacted: z.literal(false),
    externalDeliveryTriggered: z.literal(false),
    supportCompletionTriggered: z.literal(false),
    revertTriggered: z.literal(false),
    executionAuthorized: z.literal(false),
  })
  .strict()

export type SupportPackageApplicationProposalSnapshot = z.infer<
  typeof SupportPackageApplicationProposalSnapshot
>

/** Reviewed authority for one internal-only support note. Issuers must cap this
 * policy at one use; no attachment, customer visibility, or lifecycle effect is permitted. */
export const SupportInternalNotePolicyConstraints = z
  .object({
    contractVersion: z.literal(1),
    effect: z.literal('INTERNAL_NOTE_ONLY'),
    allowedVisibilities: z.tuple([z.literal('INTERNAL_ONLY')]),
    maxAttachments: z.literal(0),
    maxBodyChars: z.number().int().min(1).max(20_000),
  })
  .strict()

export type SupportInternalNotePolicyConstraints = z.infer<
  typeof SupportInternalNotePolicyConstraints
>

export const SupportInternalNotePolicyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    visibility: z.literal('INTERNAL_ONLY'),
    body: z.string().trim().min(1).max(20_000),
    attachmentCount: z.literal(0),
  })
  .strict()

export type SupportInternalNotePolicyParameters = z.infer<
  typeof SupportInternalNotePolicyParameters
>

export function defaultSupportInternalNotePolicyConstraints(): SupportInternalNotePolicyConstraints {
  return {
    contractVersion: 1,
    effect: 'INTERNAL_NOTE_ONLY',
    allowedVisibilities: ['INTERNAL_ONLY'],
    maxAttachments: 0,
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
