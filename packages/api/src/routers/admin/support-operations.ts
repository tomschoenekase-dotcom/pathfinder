import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { SupportMessageVisibility } from '@pathfinder/contracts/support-workflow'
import { appendSupportMessageAction, SupportActionError } from '@pathfinder/db'

import { router } from '../../core'
import {
  SUPPORT_PAGE_DEFAULT,
  SUPPORT_PAGE_MAX,
  SupportAttachmentDraftInput,
} from '../../schemas/support'
import { adminProcedure } from '../../trpc'

const adminScope = z
  .object({
    tenantId: z.string().min(1),
    venueId: z.string().min(1),
  })
  .strict()

const requestSelect = {
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

const messageSelect = {
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
      sourceId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const

function serializeMessage<T extends { attachments: Array<{ byteSize: bigint }> }>(message: T) {
  return {
    ...message,
    attachments: message.attachments.map((attachment) => ({
      ...attachment,
      byteSize: attachment.byteSize.toString(),
    })),
  }
}

const requestCursor = z
  .object({ updatedAt: z.string().datetime({ offset: true }), id: z.string().min(1) })
  .strict()

const messageCursor = z
  .object({ createdAt: z.string().datetime({ offset: true }), id: z.string().min(1) })
  .strict()

const auditCursor = z
  .object({ requestVersion: z.number().int().positive(), id: z.string().min(1) })
  .strict()

function supportActionError(error: unknown): never {
  if (error instanceof SupportActionError)
    throw new TRPCError({ code: error.code, message: error.message })
  throw error
}

export const adminSupportOperationsRouter = router({
  listSupportRequests: adminProcedure
    .input(
      adminScope.extend({
        cursor: requestCursor.optional(),
        limit: z.number().int().min(1).max(SUPPORT_PAGE_MAX).default(SUPPORT_PAGE_DEFAULT),
      }),
    )
    .query(async ({ ctx, input }) => {
      const cursorDate = input.cursor ? new Date(input.cursor.updatedAt) : null
      const rows = await ctx.db.supportRequest.findMany({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          ...(input.cursor
            ? {
                AND: [
                  {
                    OR: [
                      { updatedAt: { lt: cursorDate! } },
                      { updatedAt: cursorDate!, id: { lt: input.cursor.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: requestSelect,
      })
      const items = rows.slice(0, input.limit)
      const last = items.at(-1)
      return {
        items,
        nextCursor:
          rows.length > input.limit && last
            ? { updatedAt: last.updatedAt.toISOString(), id: last.id }
            : null,
      }
    }),

  getSupportRequest: adminProcedure
    .input(adminScope.extend({ requestId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const request = await ctx.db.supportRequest.findFirst({
        where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
        select: requestSelect,
      })
      if (!request) throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request not found' })
      return request
    }),

  listSupportAuditEvents: adminProcedure
    .input(
      adminScope.extend({
        requestId: z.string().min(1),
        cursor: auditCursor.optional(),
        limit: z.number().int().min(1).max(SUPPORT_PAGE_MAX).default(SUPPORT_PAGE_DEFAULT),
      }),
    )
    .query(async ({ ctx, input }) => {
      const request = await ctx.db.supportRequest.findFirst({
        where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
        select: { id: true },
      })
      if (!request) throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request not found' })

      const rows = await ctx.db.supportRequestAuditEvent.findMany({
        where: {
          supportRequestId: request.id,
          tenantId: input.tenantId,
          venueId: input.venueId,
          ...(input.cursor
            ? {
                OR: [
                  { requestVersion: { lt: input.cursor.requestVersion } },
                  { requestVersion: input.cursor.requestVersion, id: { lt: input.cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ requestVersion: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          requestVersion: true,
          eventType: true,
          actorKind: true,
          actorId: true,
          fromStatus: true,
          toStatus: true,
          createdAt: true,
        },
      })
      const items = rows.slice(0, input.limit)
      const last = items.at(-1)
      return {
        items,
        nextCursor:
          rows.length > input.limit && last
            ? { requestVersion: last.requestVersion, id: last.id }
            : null,
      }
    }),

  listSupportMessages: adminProcedure
    .input(
      adminScope.extend({
        requestId: z.string().min(1),
        cursor: messageCursor.optional(),
        limit: z.number().int().min(1).max(SUPPORT_PAGE_MAX).default(SUPPORT_PAGE_DEFAULT),
      }),
    )
    .query(async ({ ctx, input }) => {
      const cursorDate = input.cursor ? new Date(input.cursor.createdAt) : null
      const request = await ctx.db.supportRequest.findFirst({
        where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
        select: { id: true },
      })
      if (!request) throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request not found' })

      const rows = await ctx.db.supportMessage.findMany({
        where: {
          supportRequestId: request.id,
          tenantId: input.tenantId,
          venueId: input.venueId,
          ...(input.cursor
            ? {
                AND: [
                  {
                    OR: [
                      { createdAt: { gt: cursorDate! } },
                      { createdAt: cursorDate!, id: { gt: input.cursor.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: input.limit + 1,
        select: messageSelect,
      })
      const items = rows.slice(0, input.limit).map(serializeMessage)
      const last = rows.slice(0, input.limit).at(-1)
      return {
        items,
        nextCursor:
          rows.length > input.limit && last
            ? { createdAt: last.createdAt.toISOString(), id: last.id }
            : null,
      }
    }),

  addSupportMessage: adminProcedure
    .input(
      adminScope.extend({
        requestId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        visibility: SupportMessageVisibility,
        body: z.string().trim().min(1).max(20_000),
        attachments: z.array(SupportAttachmentDraftInput).max(20).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await appendSupportMessageAction(
          {
            tenantId: input.tenantId,
            venueId: input.venueId,
            requestId: input.requestId,
            expectedVersion: input.expectedVersion,
            visibility: input.visibility,
            body: input.body,
            attachments: input.attachments,
            actor: {
              actorType: 'HUMAN',
              participantKind: 'OPERATOR',
              actorId: ctx.session.userId,
              auditRole: 'PLATFORM_ADMIN',
            },
          },
          ctx.db,
        )
        return { message: serializeMessage(result.message), requestVersion: result.requestVersion }
      } catch (error) {
        return supportActionError(error)
      }
    }),
})
