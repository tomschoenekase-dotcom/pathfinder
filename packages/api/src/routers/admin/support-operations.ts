import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  SupportMessageVisibility,
  SupportRequestStatus,
} from '@pathfinder/contracts/support-workflow'
import {
  appendSupportMessageAction,
  linkSupportRequestDraftPackageAction,
  transitionSupportRequestStatusAction,
} from '@pathfinder/db'

import { router } from '../../core'
import {
  SUPPORT_PAGE_DEFAULT,
  SUPPORT_PAGE_MAX,
  SupportAttachmentDraftInput,
} from '../../schemas/support'
import { adminProcedure } from '../../trpc'
import {
  adminSupportScope as adminScope,
  serializeSupportMessage as serializeMessage,
  supportActionError,
  supportAuditCursor as auditCursor,
  supportMessageCursor as messageCursor,
  supportMessageSelect as messageSelect,
  supportRequestCursor as requestCursor,
  supportRequestSelect as requestSelect,
} from './support-operations-shared'

export const adminSupportOperationsRouter = router({
  transitionSupportRequestStatus: adminProcedure
    .input(
      adminScope.extend({
        requestId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        toStatus: SupportRequestStatus,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await transitionSupportRequestStatusAction(
          {
            ...input,
            actor: {
              actorType: 'HUMAN',
              participantKind: 'OPERATOR',
              actorId: ctx.session.userId,
              auditRole: 'PLATFORM_ADMIN',
            },
          },
          ctx.db,
        )
      } catch (error) {
        return supportActionError(error)
      }
    }),

  listSupportDraftPackages: adminProcedure
    .input(
      adminScope.extend({
        requestId: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const request = await ctx.db.supportRequest.findFirst({
        where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
        select: { id: true },
      })
      if (!request) throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request not found' })
      return ctx.db.venuePackage.findMany({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          status: 'DRAFT',
          supportHandoffs: { none: {} },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
        select: {
          id: true,
          schemaVersion: true,
          payloadHash: true,
          createdBy: true,
          createdAt: true,
        },
      })
    }),

  listSupportPackageHandoffs: adminProcedure
    .input(adminScope.extend({ requestId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const request = await ctx.db.supportRequest.findFirst({
        where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
        select: { id: true },
      })
      if (!request) throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request not found' })
      return ctx.db.supportPackageHandoff.findMany({
        where: { tenantId: input.tenantId, venueId: input.venueId, supportRequestId: request.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        select: {
          id: true,
          venuePackageId: true,
          requestVersion: true,
          linkedByKind: true,
          linkedById: true,
          createdAt: true,
          venuePackage: { select: { status: true, schemaVersion: true, payloadHash: true } },
        },
      })
    }),

  linkSupportDraftPackage: adminProcedure
    .input(
      adminScope.extend({
        requestId: z.string().min(1),
        venuePackageId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await linkSupportRequestDraftPackageAction(
          {
            ...input,
            actor: {
              actorType: 'HUMAN',
              participantKind: 'OPERATOR',
              actorId: ctx.session.userId,
              auditRole: 'PLATFORM_ADMIN',
            },
          },
          ctx.db,
        )
      } catch (error) {
        return supportActionError(error)
      }
    }),

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
