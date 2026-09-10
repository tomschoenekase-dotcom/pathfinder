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
export const INTAKE_V1_PACKAGE_DRAFT_APPLY_ACTION =
  'pathfinder.apply_intake_v1_package_draft' as const
export const INTAKE_V1_PACKAGE_DRAFT_CAPABILITY = 'packages:draft' as const
export const SUPPORT_PACKAGE_APPROVAL_APPLY_ACTION =
  'pathfinder.apply_support_package_approval' as const
export const SUPPORT_PACKAGE_APPROVAL_CAPABILITY = 'packages:approve' as const
export const SUPPORT_PACKAGE_APPLICATION_APPLY_ACTION =
  'pathfinder.apply_support_package_application' as const
export const SUPPORT_PACKAGE_APPLICATION_CAPABILITY = 'packages:apply' as const
export const SUPPORT_PACKAGE_REVERSION_APPLY_ACTION =
  'pathfinder.apply_support_package_reversion' as const
export const SUPPORT_PACKAGE_REVERSION_CAPABILITY = 'packages:revert' as const
export const SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_APPLY_ACTION =
  'pathfinder.apply_support_package_handoff_supersession' as const
export const SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_CAPABILITY = 'packages:reconcile' as const
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
const SupportCompletionPackageEvidence = z
  .object({
    handoffId: z.string().trim().min(1).max(191),
    packageId: z.string().trim().min(1).max(191),
    handoffRequestVersion: z.number().int().positive(),
    status: z.literal('APPLIED'),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    appliedAt: z.string().datetime(),
    appliedBy: z.string().trim().min(1).max(191),
    appliedCommandKey: z.string().uuid(),
    packageUpdatedAt: z.string().datetime(),
  })
  .strict()

const supportCompletionPackageShape = {
  linkedPackageCount: z.number().int().nonnegative(),
  packages: z.array(SupportCompletionPackageEvidence),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
} as const

export const SupportCompletionPackageFulfillmentV1 = z
  .object({
    contractVersion: z.literal(1),
    ...supportCompletionPackageShape,
  })
  .strict()

export const SupportCompletionGuestObservability = z
  .object({
    contractVersion: z.literal(1),
    configuredPath: z.enum(['NOT_APPLICABLE', 'LEGACY', 'DARK', 'NATIVE']),
    reason: z.enum([
      'NO_LINKED_PACKAGES',
      'SERVER_DISABLED',
      'POLICY_MISSING',
      'POLICY_INVALID',
      'PRODUCTION_APPROVAL_MISSING',
      'HEAD_INVALID',
      'EVALUATION_INVALID',
      'NATIVE_READY',
    ]),
    releaseId: z.string().trim().min(1).max(191).nullable(),
    nativeStateHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    effects: z
      .array(
        z
          .object({
            packageId: z.string().trim().min(1).max(191),
            applyVersionId: z.string().uuid(),
            entityType: z.enum(['VENUE', 'PLACE', 'KNOWLEDGE_ENTRY']),
            entityId: z.string().trim().min(1).max(191),
            operation: z.enum(['CREATE', 'UPDATE', 'DELETE']),
            readPath: z.enum(['LIVE_VENUE', 'LEGACY', 'DARK', 'NATIVE']),
            expectedGuestStateHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
            observedGuestStateHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
          })
          .strict(),
      )
      .max(500),
    verifiedAt: z.string().datetime(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type SupportCompletionGuestObservability = z.infer<
  typeof SupportCompletionGuestObservability
>

export const SupportCompletionPackageFulfillmentV2 = z
  .object({
    contractVersion: z.literal(2),
    ...supportCompletionPackageShape,
    guestObservability: SupportCompletionGuestObservability,
  })
  .strict()

export const SupportCompletionContentFulfillment = z
  .object({
    contractVersion: z.literal(1),
    receipts: z
      .array(
        z
          .object({
            receiptKind: z.enum(['UNIVERSAL', 'ADOPTION']),
            receiptId: z.string().min(1).max(191),
            proposalId: z.string().min(1).max(191),
            sourceProposalId: z.string().min(1).max(191),
            sourceRequestVersion: z.number().int().positive(),
            moduleId: z.string().min(1).max(191),
            revisionId: z.string().min(1).max(191),
            publicationId: z.string().min(1).max(191),
            projectionId: z.string().min(1).max(191),
            observedStateHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(100),
    guestRead: z
      .object({
        path: z.enum(['NOT_APPLICABLE', 'LEGACY', 'DARK', 'NATIVE']),
        releaseId: z.string().min(1).max(191).nullable(),
        nativeStateHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .strict(),
    verifiedAt: z.string().datetime(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.receipts.length === 0) !== (value.guestRead.path === 'NOT_APPLICABLE')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guestRead'],
        message: 'Content receipts require an applicable guest read.',
      })
    }
    if (
      new Set(value.receipts.map((receipt) => `${receipt.receiptKind}:${receipt.receiptId}`))
        .size !== value.receipts.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receipts'],
        message: 'Content fulfillment contains duplicate receipts.',
      })
    }
    if (
      value.guestRead.path === 'NATIVE' &&
      (!value.guestRead.releaseId || !value.guestRead.nativeStateHash)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guestRead'],
        message: 'Native content fulfillment requires exact release and state identity.',
      })
    }
  })

export const SupportCompletionPackageFulfillmentV3 = z
  .object({
    contractVersion: z.literal(3),
    ...supportCompletionPackageShape,
    guestObservability: SupportCompletionGuestObservability,
    contentFulfillment: SupportCompletionContentFulfillment,
  })
  .strict()

export const SupportCompletionTemporalFulfillment = z
  .object({
    contractVersion: z.literal(1),
    receipts: z
      .array(
        z
          .object({
            handoffId: z.string().min(1).max(191),
            proposalId: z.string().min(1).max(191),
            sourceProposalId: z.string().min(1).max(191),
            sourceRequestVersion: z.number().int().positive(),
            operationalUpdateId: z.string().min(1).max(191),
            updatedAt: z.string().datetime(),
            publishedAt: z.string().datetime(),
            startsAt: z.string().datetime(),
            expiresAt: z.string().datetime(),
            observedStateHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(100),
    verifiedAt: z.string().datetime(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.receipts.map((receipt) => receipt.handoffId)).size !== value.receipts.length ||
      new Set(value.receipts.map((receipt) => receipt.operationalUpdateId)).size !==
        value.receipts.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receipts'],
        message: 'Temporal fulfillment contains duplicate evidence.',
      })
    }
    value.receipts.forEach((receipt, index) => {
      if (
        !(
          Date.parse(receipt.startsAt) <= Date.parse(value.verifiedAt) &&
          Date.parse(value.verifiedAt) < Date.parse(receipt.expiresAt)
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['receipts', index],
          message: 'Temporal fulfillment must be currently effective at verification.',
        })
      }
    })
  })

export const SupportCompletionPackageFulfillmentV4 = z
  .object({
    contractVersion: z.literal(4),
    ...supportCompletionPackageShape,
    guestObservability: SupportCompletionGuestObservability,
    contentFulfillment: SupportCompletionContentFulfillment,
    temporalFulfillment: SupportCompletionTemporalFulfillment,
  })
  .strict()

const supportCompletionChainedReceiptShape = {
  receiptKind: z.enum(['UNIVERSAL', 'ADOPTION']),
  receiptId: z.string().min(1).max(191),
  proposalId: z.string().min(1).max(191),
  sourceProposalId: z.string().min(1).max(191),
  sourceRequestVersion: z.number().int().positive(),
  replacementOfProposalId: z.string().min(1).max(191).nullable(),
  moduleId: z.string().min(1).max(191),
  moduleKind: z.enum(['ITEM', 'SERVICE', 'POLICY', 'EVENT', 'OPERATIONAL_FACT', 'RELATIONSHIP']),
  revisionId: z.string().min(1).max(191),
  revisionVersion: z.number().int().positive(),
  effectiveFrom: z.string().datetime().nullable(),
  effectiveUntil: z.string().datetime().nullable(),
  operationalFactExpiresAt: z.string().datetime().nullable(),
  classification: z.string().min(1).max(32).nullable(),
  relation: z.string().min(1).max(32).nullable(),
  expectedBaseRevisionId: z.string().min(1).max(191).nullable(),
  expectedBaseVersion: z.number().int().positive().nullable(),
} as const

export const SupportCompletionContentFulfillmentV2 = z
  .object({
    contractVersion: z.literal(2),
    receipts: z
      .array(
        z.discriminatedUnion('state', [
          z
            .object({
              ...supportCompletionChainedReceiptShape,
              state: z.literal('CURRENT'),
              supersededByReceiptId: z.null(),
              publicationId: z.string().min(1).max(191),
              projectionId: z.string().min(1).max(191),
              observedStateHash: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
          z
            .object({
              ...supportCompletionChainedReceiptShape,
              state: z.literal('SUPERSEDED'),
              supersededByReceiptId: z.string().min(1).max(191),
              publicationId: z.null(),
              projectionId: z.null(),
              observedStateHash: z.null(),
            })
            .strict(),
        ]),
      )
      .max(100),
    guestRead: SupportCompletionContentFulfillment.innerType().shape.guestRead,
    verifiedAt: z.string().datetime(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['receipts'], message })
    if ((value.receipts.length === 0) !== (value.guestRead.path === 'NOT_APPLICABLE'))
      issue('Content receipts require an applicable guest read.')
    if (
      value.guestRead.path === 'NATIVE' &&
      (!value.guestRead.releaseId || !value.guestRead.nativeStateHash)
    )
      issue('Native content fulfillment requires exact release and state identity.')
    if (
      new Set(value.receipts.map((receipt) => receipt.receiptId)).size !== value.receipts.length ||
      new Set(value.receipts.map((receipt) => receipt.revisionId)).size !== value.receipts.length
    )
      issue('Chained content fulfillment contains duplicate identity.')
    const groups = new Map<string, typeof value.receipts>()
    for (const receipt of value.receipts) {
      if (receipt.state === 'CURRENT') {
        const at = Date.parse(value.verifiedAt)
        if (
          (receipt.effectiveFrom !== null && Date.parse(receipt.effectiveFrom) > at) ||
          (receipt.effectiveUntil !== null && Date.parse(receipt.effectiveUntil) <= at) ||
          (receipt.operationalFactExpiresAt !== null &&
            Date.parse(receipt.operationalFactExpiresAt) <= at)
        )
          issue('Current content receipt must be effective at verification.')
      }

      const emptyBase =
        receipt.expectedBaseRevisionId === null && receipt.expectedBaseVersion === null
      const appendBase =
        receipt.expectedBaseRevisionId !== null &&
        receipt.expectedBaseVersion !== null &&
        receipt.expectedBaseVersion + 1 === receipt.revisionVersion
      if (receipt.receiptKind === 'ADOPTION') {
        if (!emptyBase || receipt.classification !== null || receipt.relation !== null)
          issue('Adoption evidence must be a root without semantic base fields.')
      } else {
        const addition =
          receipt.classification === 'ADDITION' && receipt.relation === 'NEW_FACT' && emptyBase
        const correction =
          receipt.classification === 'CORRECTION' && receipt.relation === 'CORRECTS' && appendBase
        const supersession =
          receipt.classification === 'SUPERSESSION' &&
          receipt.relation === 'SUPERSEDES' &&
          appendBase
        if (!addition && !correction && !supersession)
          issue('Universal receipt semantic relation and exact base are inconsistent.')
      }
      const localBase = value.receipts.find(
        (base) => base.revisionId === receipt.expectedBaseRevisionId,
      )
      if (
        localBase &&
        (localBase.moduleId !== receipt.moduleId ||
          localBase.moduleKind !== receipt.moduleKind ||
          localBase.state !== 'SUPERSEDED' ||
          localBase.supersededByReceiptId !== receipt.receiptId)
      )
        issue('A local base must explicitly link to its same-module successor.')
      const group = groups.get(receipt.moduleId) ?? []
      group.push(receipt)
      groups.set(receipt.moduleId, group)
      if (receipt.state === 'SUPERSEDED') {
        const successor = value.receipts.find(
          (next) =>
            next.receiptKind === 'UNIVERSAL' && next.receiptId === receipt.supersededByReceiptId,
        )
        if (
          !successor ||
          successor.moduleId !== receipt.moduleId ||
          successor.moduleKind !== receipt.moduleKind ||
          successor.revisionVersion !== receipt.revisionVersion + 1 ||
          successor.expectedBaseRevisionId !== receipt.revisionId ||
          successor.expectedBaseVersion !== receipt.revisionVersion
        )
          issue('Superseded receipt requires its exact consecutive successor.')
        if (successor) {
          const semanticPair =
            (successor.classification === 'CORRECTION' && successor.relation === 'CORRECTS') ||
            (successor.classification === 'SUPERSESSION' && successor.relation === 'SUPERSEDES')
          const orderedSource =
            successor.sourceRequestVersion > receipt.sourceRequestVersion ||
            (successor.sourceRequestVersion === receipt.sourceRequestVersion &&
              successor.replacementOfProposalId === receipt.proposalId &&
              successor.sourceProposalId === receipt.proposalId)
          if (!semanticPair || !orderedSource)
            issue(
              'Receipt successor requires an approved semantic relation and forward source lineage.',
            )
        }
      }
    }
    for (const group of groups.values()) {
      if (
        group.filter((receipt) => receipt.state === 'CURRENT').length !== 1 ||
        new Set(group.map((receipt) => receipt.moduleKind)).size !== 1
      )
        issue('Each module must have one current terminal and one kind.')
    }
  })

export const SupportCompletionPackageFulfillmentV5 = z
  .object({
    contractVersion: z.literal(5),
    ...supportCompletionPackageShape,
    guestObservability: SupportCompletionGuestObservability,
    contentFulfillment: SupportCompletionContentFulfillmentV2,
    temporalFulfillment: SupportCompletionTemporalFulfillment,
  })
  .strict()

export const SupportCompletionPackageFulfillment = z
  .discriminatedUnion('contractVersion', [
    SupportCompletionPackageFulfillmentV1,
    SupportCompletionPackageFulfillmentV2,
    SupportCompletionPackageFulfillmentV3,
    SupportCompletionPackageFulfillmentV4,
    SupportCompletionPackageFulfillmentV5,
  ])
  .superRefine((value, context) => {
    if (value.linkedPackageCount !== value.packages.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['linkedPackageCount'],
        message: 'Linked package count does not match the exact fulfillment evidence.',
      })
    }
    const packageIds = value.packages.map(({ packageId }) => packageId)
    if (new Set(packageIds).size !== packageIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packages'],
        message: 'Support completion package evidence contains duplicate packages.',
      })
    }
    if (value.contractVersion === 1) return
    const observation = value.guestObservability
    const packageFree = value.linkedPackageCount === 0
    const notApplicable =
      observation.configuredPath === 'NOT_APPLICABLE' &&
      observation.reason === 'NO_LINKED_PACKAGES' &&
      observation.effects.length === 0
    if (
      packageFree
        ? !notApplicable
        : observation.configuredPath === 'NOT_APPLICABLE' ||
          observation.reason === 'NO_LINKED_PACKAGES'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guestObservability'],
        message: 'Package-free observability is only valid when no packages are linked.',
      })
    }
    if (!packageFree && observation.effects.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guestObservability', 'effects'],
        message: 'Linked packages require exact guest-visible effect evidence.',
      })
    }
    const applyVersionIds = observation.effects.map(({ applyVersionId }) => applyVersionId)
    if (new Set(applyVersionIds).size !== applyVersionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guestObservability', 'effects'],
        message: 'Guest observability contains duplicate apply evidence.',
      })
    }
    observation.effects.forEach((effect, index) => {
      if (!packageIds.includes(effect.packageId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['guestObservability', 'effects', index, 'packageId'],
          message: 'Guest observability references an unlinked package.',
        })
      }
      if (effect.expectedGuestStateHash !== effect.observedGuestStateHash) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['guestObservability', 'effects', index, 'observedGuestStateHash'],
          message: 'Observed guest state does not match the applied guest-visible state.',
        })
      }
    })
    const nativeIdentityPresent =
      observation.releaseId !== null && observation.nativeStateHash !== null
    if ((observation.configuredPath === 'NATIVE') !== nativeIdentityPresent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guestObservability', 'nativeStateHash'],
        message: 'Native observability requires one exact release and native state hash.',
      })
    }
  })

export type SupportCompletionPackageFulfillment = z.infer<
  typeof SupportCompletionPackageFulfillment
>

export const SupportCompletionApplyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    fromStatus: z.enum(['OPEN', 'IN_REVIEW']),
    toStatus: z.literal('COMPLETED'),
    body: z.string().trim().min(1).max(20_000),
    packageFulfillment: SupportCompletionPackageFulfillment,
  })
  .strict()

export type SupportCompletionApplyParameters = z.infer<typeof SupportCompletionApplyParameters>

export const SupportCompletionProposalApprovalSnapshot = z
  .object({
    contractVersion: z.literal(2),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    fromStatus: z.enum(['OPEN', 'IN_REVIEW']),
    toStatus: z.literal('COMPLETED'),
    body: z.string().trim().min(1).max(20_000),
    missingInformationCount: z.literal(0),
    packageFulfillment: SupportCompletionPackageFulfillment,
    allLinkedPackagesApplied: z.literal(true),
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

const IntakeV1ExactSelection = z
  .array(z.string().trim().min(1).max(191))
  .min(1)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, 'Selected member IDs must be unique.')
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)

/** One-shot authority to create one inactive V3 draft from an exact, server-derived V1 candidate. */
export const IntakeV1PackageDraftApplyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    submissionId: z.string().trim().min(1).max(191),
    revision: z.number().int().positive(),
    manifestHash: Sha256,
    candidateHash: Sha256,
    payloadHash: Sha256,
    selectionHash: Sha256,
    selectedMemberIds: IntakeV1ExactSelection,
    partialAcknowledged: z.boolean(),
    draftOperationId: z.string().uuid(),
  })
  .strict()
export type IntakeV1PackageDraftApplyParameters = z.infer<
  typeof IntakeV1PackageDraftApplyParameters
>

export const IntakeV1PackageDraftProposalApprovalSnapshot = z
  .object({
    contractVersion: z.literal(1),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    submissionId: z.string().trim().min(1).max(191),
    revision: z.number().int().positive(),
    manifestHash: Sha256,
    candidateHash: Sha256,
    payloadHash: Sha256,
    selectionHash: Sha256,
    selectedMemberIds: IntakeV1ExactSelection,
    partialAcknowledged: z.boolean(),
    draftOperationId: z.string().uuid(),
    packageDraftCreated: z.literal(false),
    packageApproved: z.literal(false),
    packageApplied: z.literal(false),
    packagePublished: z.literal(false),
    executionAuthorized: z.literal(false),
  })
  .strict()
export type IntakeV1PackageDraftProposalApprovalSnapshot = z.infer<
  typeof IntakeV1PackageDraftProposalApprovalSnapshot
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

/** Exact one-shot authority for one founder-reviewed rollback of an unchanged,
 * support-linked APPLIED package. The canonical package rollback still performs
 * its own content-drift and recoverability checks at execution time. */
export const SupportPackageReversionApplyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    packageId: z.string().trim().min(1).max(191),
    expectedUpdatedAt: z.string().datetime(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    baseDigest: z.string().regex(/^[a-f0-9]{64}$/),
    rollbackManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    appliedAt: z.string().datetime(),
    appliedBy: z.string().trim().min(1).max(191),
    appliedCommandKey: z.string().uuid(),
    supportHandoff: SupportPackageApprovalHandoff,
    supportRequestVersion: z.number().int().positive(),
    supportRequestStatus: z.enum(['OPEN', 'IN_REVIEW']),
  })
  .strict()

export type SupportPackageReversionApplyParameters = z.infer<
  typeof SupportPackageReversionApplyParameters
>

export const SupportPackageReversionProposalSnapshot = z
  .object({
    contractVersion: z.literal(1),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    packageId: z.string().trim().min(1).max(191),
    expectedUpdatedAt: z.string().datetime(),
    fromStatus: z.literal('APPLIED'),
    toStatus: z.literal('REVERTED'),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    baseDigest: z.string().regex(/^[a-f0-9]{64}$/),
    rollbackManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    appliedAt: z.string().datetime(),
    appliedBy: z.string().trim().min(1).max(191),
    appliedCommandKey: z.string().uuid(),
    supportHandoff: SupportPackageApprovalHandoff,
    supportRequestVersion: z.number().int().positive(),
    supportRequestStatus: z.enum(['OPEN', 'IN_REVIEW']),
    currentContentMutation: z.literal(true),
    visitorVisibleChangePossible: z.literal(true),
    canonicalDriftCheckRequired: z.literal(true),
    automaticRollbackPolicyApplied: z.literal(false),
    supportRequestChanged: z.literal(false),
    customerContacted: z.literal(false),
    externalDeliveryTriggered: z.literal(false),
    executionAuthorized: z.literal(false),
  })
  .strict()

export type SupportPackageReversionProposalSnapshot = z.infer<
  typeof SupportPackageReversionProposalSnapshot
>

export const SupersededSupportPackageHandoff = z
  .object({
    handoffId: z.string().trim().min(1).max(191),
    packageId: z.string().trim().min(1).max(191),
    handoffRequestVersion: z.number().int().positive(),
    packageUpdatedAt: z.string().datetime(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    revertedAt: z.string().datetime(),
    revertedBy: z.string().trim().min(1).max(191),
    revertedCommandKey: z.string().uuid(),
  })
  .strict()

export const ReplacementSupportPackageHandoff = z
  .object({
    handoffId: z.string().trim().min(1).max(191),
    packageId: z.string().trim().min(1).max(191),
    handoffRequestVersion: z.number().int().positive(),
    packageUpdatedAt: z.string().datetime(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    appliedAt: z.string().datetime(),
    appliedBy: z.string().trim().min(1).max(191),
    appliedCommandKey: z.string().uuid(),
  })
  .strict()

/** Exact one-shot authority to append current-truth lineage from one reverted
 * support package handoff to one separately linked, fully applied replacement.
 * It changes no package content, support status, client activity, or message. */
export const SupportPackageHandoffSupersessionApplyParameters = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    supportRequestStatus: z.enum(['OPEN', 'IN_REVIEW']),
    superseded: SupersededSupportPackageHandoff,
    replacement: ReplacementSupportPackageHandoff,
  })
  .strict()
  .refine((value) => value.superseded.handoffId !== value.replacement.handoffId, {
    path: ['replacement', 'handoffId'],
    message: 'Replacement handoff must differ from the superseded handoff.',
  })

export type SupportPackageHandoffSupersessionApplyParameters = z.infer<
  typeof SupportPackageHandoffSupersessionApplyParameters
>

export const SupportPackageHandoffSupersessionProposalSnapshot = z
  .object({
    contractVersion: z.literal(1),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    supportRequestStatus: z.enum(['OPEN', 'IN_REVIEW']),
    superseded: SupersededSupportPackageHandoff,
    replacement: ReplacementSupportPackageHandoff,
    historicalHandoffPreserved: z.literal(true),
    replacementAlreadyApplied: z.literal(true),
    packageLifecycleChanged: z.literal(false),
    supportRequestChanged: z.literal(false),
    supportStatusChanged: z.literal(false),
    clientActivityChanged: z.literal(false),
    customerContacted: z.literal(false),
    externalDeliveryTriggered: z.literal(false),
    executionAuthorized: z.literal(false),
  })
  .strict()

export type SupportPackageHandoffSupersessionProposalSnapshot = z.infer<
  typeof SupportPackageHandoffSupersessionProposalSnapshot
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
