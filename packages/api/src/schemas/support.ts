import { z } from 'zod'

import {
  SupportAttachmentReferences,
  SupportAttachmentReference,
  SupportRequestCategory,
} from '@pathfinder/contracts/support-workflow'
import { IntakeUploadCursor } from '@pathfinder/contracts/intake-upload'

export const SUPPORT_PAGE_DEFAULT = 20
export const SUPPORT_PAGE_MAX = 50
/** Compatibility name; the browser now supplies only a trusted upload reference. */
export const SupportAttachmentDraftInput = SupportAttachmentReference

export const SupportCursorInput = z
  .object({
    clientActivityAt: z.string().datetime({ offset: true }),
    id: z.string().min(1),
  })
  .strict()

export const SupportPageInput = z
  .object({
    venueId: z.string().min(1),
    cursor: SupportCursorInput.optional(),
    limit: z.number().int().min(1).max(SUPPORT_PAGE_MAX).default(SUPPORT_PAGE_DEFAULT),
  })
  .strict()

export const CreateSupportRequestInput = z
  .object({
    operationId: z.string().uuid(),
    venueId: z.string().min(1),
    category: SupportRequestCategory,
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000),
    attachments: SupportAttachmentReferences.default([]),
  })
  .strict()

export const SupportRequestRefInput = z
  .object({
    venueId: z.string().min(1),
    requestId: z.string().min(1),
  })
  .strict()

export const GetSupportRequestInput = SupportRequestRefInput.extend({
  messageCursor: z
    .object({
      createdAt: z.string().datetime({ offset: true }),
      id: z.string().min(1),
    })
    .strict()
    .optional(),
  messageLimit: z.number().int().min(1).max(SUPPORT_PAGE_MAX).default(SUPPORT_PAGE_DEFAULT),
}).strict()

export const AddClientSupportMessageInput = SupportRequestRefInput.extend({
  operationId: z.string().uuid(),
  expectedClientVersion: z.number().int().positive(),
  body: z.string().trim().min(1).max(20_000),
  attachments: SupportAttachmentReferences.default([]),
}).strict()

export const RespondToSupportInformationInput = SupportRequestRefInput.extend({
  operationId: z.string().uuid(),
  expectedClientVersion: z.number().int().positive(),
  body: z.string().trim().min(1).max(20_000),
  attachments: SupportAttachmentReferences.default([]),
}).strict()

export const ManageSupportParticipantInput = SupportRequestRefInput.extend({
  operationId: z.string().uuid(),
  userId: z.string().trim().min(1).max(191),
  expectedClientVersion: z.number().int().positive(),
}).strict()

export const EligibleSupportAttachmentsInput = z
  .object({
    venueId: z.string().trim().min(1).max(191),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: IntakeUploadCursor.optional(),
  })
  .strict()
