import { z } from 'zod'

import { SupportRequestCategory } from '@pathfinder/contracts/support-workflow'

export const SUPPORT_PAGE_DEFAULT = 20
export const SUPPORT_PAGE_MAX = 50
export const SUPPORT_ATTACHMENT_MAX_BYTES = 1_000_000_000

export const SupportCursorInput = z
  .object({
    updatedAt: z.string().datetime({ offset: true }),
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

export const SupportAttachmentDraftInput = z
  .object({
    filename: z.string().trim().min(1).max(255),
    mediaType: z.string().trim().min(1).max(127),
    byteSize: z.number().int().nonnegative().max(SUPPORT_ATTACHMENT_MAX_BYTES),
    sourceId: z.string().min(1).max(191).optional(),
  })
  .strict()

export const CreateSupportRequestInput = z
  .object({
    venueId: z.string().min(1),
    category: SupportRequestCategory,
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000),
    attachments: z.array(SupportAttachmentDraftInput).max(20).default([]),
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
  expectedVersion: z.number().int().positive(),
  body: z.string().trim().min(1).max(20_000),
  attachments: z.array(SupportAttachmentDraftInput).max(20).default([]),
}).strict()
