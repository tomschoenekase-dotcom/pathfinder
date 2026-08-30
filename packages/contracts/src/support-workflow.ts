import { z } from 'zod'

export const SupportRequestStatus = z.enum([
  'DRAFT',
  'OPEN',
  'WAITING_FOR_CLIENT',
  'IN_REVIEW',
  'PATCH_DRAFTED',
  'VALIDATING',
  'AWAITING_APPROVAL',
  'APPLYING',
  'COMPLETED',
  'CANCELLED',
])
export type SupportRequestStatus = z.infer<typeof SupportRequestStatus>

export const SupportRequestCategory = z.enum([
  'CONTENT_CORRECTION',
  'OPERATIONAL_UPDATE',
  'BRANDING',
  'EXPERIENCE_BEHAVIOR',
  'ACCESSIBILITY',
  'GENERAL',
])
export type SupportRequestCategory = z.infer<typeof SupportRequestCategory>

export const SupportParticipantKind = z.enum(['CLIENT', 'OPERATOR', 'AGENT', 'SYSTEM'])
export type SupportParticipantKind = z.infer<typeof SupportParticipantKind>

export const SupportMessageVisibility = z.enum(['CLIENT_VISIBLE', 'INTERNAL_ONLY'])
export type SupportMessageVisibility = z.infer<typeof SupportMessageVisibility>

export const SUPPORT_ATTACHMENT_REFERENCE_MAX = 20
export const SupportAttachmentReference = z
  .object({ intakeUploadId: z.string().trim().min(1).max(191) })
  .strict()
export type SupportAttachmentReference = z.infer<typeof SupportAttachmentReference>

export const SupportAttachmentReferences = z
  .array(SupportAttachmentReference)
  .max(SUPPORT_ATTACHMENT_REFERENCE_MAX)
  .superRefine((references, context) => {
    const seen = new Set<string>()
    references.forEach((reference, index) => {
      if (seen.has(reference.intakeUploadId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'intakeUploadId'],
          message: 'An intake upload can be attached only once per message.',
        })
      }
      seen.add(reference.intakeUploadId)
    })
  })
export type SupportAttachmentReferences = z.infer<typeof SupportAttachmentReferences>

export const SupportAttachment = z
  .object({
    id: z.string().min(1),
    filename: z.string().trim().min(1).max(255),
    mediaType: z.string().trim().min(1).max(127),
    byteSize: z.number().int().nonnegative(),
  })
  .strict()
export type SupportAttachment = z.infer<typeof SupportAttachment>

export const SupportMessage = z
  .object({
    id: z.string().min(1),
    authorKind: SupportParticipantKind,
    visibility: SupportMessageVisibility,
    body: z.string().trim().min(1).max(20_000),
    attachments: z.array(SupportAttachment).max(20).default([]),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.authorKind === 'CLIENT' && message.visibility === 'INTERNAL_ONLY') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['visibility'],
        message: 'Client-authored messages cannot be internal-only.',
      })
    }
  })
export type SupportMessage = z.infer<typeof SupportMessage>

export const SupportWorkflowArtifacts = z
  .object({
    intakeSourceIds: z.array(z.string().min(1)).max(100).default([]),
    packageDraftId: z.string().min(1).optional(),
    packageVersion: z.number().int().positive().optional(),
    validationRunId: z.string().min(1).optional(),
    evaluationRunId: z.string().min(1).optional(),
    approvalRequestId: z.string().min(1).optional(),
    appliedActionId: z.string().min(1).optional(),
  })
  .strict()
export type SupportWorkflowArtifacts = z.infer<typeof SupportWorkflowArtifacts>

export const SupportRequestSnapshot = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    venueId: z.string().min(1),
    category: SupportRequestCategory,
    status: SupportRequestStatus,
    subject: z.string().trim().min(1).max(200),
    missingInformation: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
    artifacts: SupportWorkflowArtifacts,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
export type SupportRequestSnapshot = z.infer<typeof SupportRequestSnapshot>

export const supportRequestTransitionGraph: Readonly<
  Record<SupportRequestStatus, readonly SupportRequestStatus[]>
> = {
  DRAFT: ['OPEN', 'CANCELLED'],
  OPEN: ['WAITING_FOR_CLIENT', 'IN_REVIEW', 'CANCELLED'],
  WAITING_FOR_CLIENT: ['IN_REVIEW', 'CANCELLED'],
  IN_REVIEW: ['WAITING_FOR_CLIENT', 'PATCH_DRAFTED', 'CANCELLED'],
  PATCH_DRAFTED: ['IN_REVIEW', 'VALIDATING', 'CANCELLED'],
  VALIDATING: ['PATCH_DRAFTED', 'AWAITING_APPROVAL', 'CANCELLED'],
  AWAITING_APPROVAL: ['PATCH_DRAFTED', 'APPLYING', 'CANCELLED'],
  APPLYING: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
}

export function canTransitionSupportRequest(
  from: SupportRequestStatus,
  to: SupportRequestStatus,
): boolean {
  return supportRequestTransitionGraph[from].includes(to)
}

export function supportRequestTransitionsFrom(
  from: SupportRequestStatus,
): readonly SupportRequestStatus[] {
  return supportRequestTransitionGraph[from]
}

export function visibleSupportMessages(
  messages: readonly SupportMessage[],
  audience: 'CLIENT' | 'INTERNAL',
): SupportMessage[] {
  return audience === 'INTERNAL'
    ? [...messages]
    : messages.filter((message) => message.visibility === 'CLIENT_VISIBLE')
}
