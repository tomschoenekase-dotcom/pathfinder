import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  SupportActionError,
  SupportPackageHandoffError,
  SupportStatusTransitionError,
} from '@pathfinder/db'

export const adminSupportScope = z
  .object({
    tenantId: z.string().min(1),
    venueId: z.string().min(1),
  })
  .strict()

export const supportRequestSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  category: true,
  status: true,
  subject: true,
  missingInformation: true,
  artifacts: true,
  version: true,
  statusChangedAt: true,
  createdByKind: true,
  createdById: true,
  updatedByKind: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
} as const

export const supportMessageSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  supportRequestId: true,
  authorKind: true,
  authorId: true,
  visibility: true,
  body: true,
  createdAt: true,
  attachments: {
    select: {
      id: true,
      filename: true,
      mediaType: true,
      byteSize: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const

export function serializeSupportMessage<T extends { attachments: Array<{ byteSize: bigint }> }>(
  message: T,
) {
  return {
    ...message,
    attachments: message.attachments.map(({ byteSize, ...attachment }) => ({
      ...attachment,
      byteSize: byteSize.toString(),
    })),
  }
}

export const supportRequestCursor = z
  .object({ updatedAt: z.string().datetime({ offset: true }), id: z.string().min(1) })
  .strict()

export const supportMessageCursor = z
  .object({ createdAt: z.string().datetime({ offset: true }), id: z.string().min(1) })
  .strict()

export const supportAuditCursor = z
  .object({ requestVersion: z.number().int().positive(), id: z.string().min(1) })
  .strict()

export function supportActionError(error: unknown): never {
  if (
    error instanceof SupportActionError ||
    error instanceof SupportPackageHandoffError ||
    error instanceof SupportStatusTransitionError
  ) {
    throw new TRPCError({
      code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
      message: error.message,
    })
  }
  throw error
}
