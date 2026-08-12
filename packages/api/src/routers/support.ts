import { TRPCError } from '@trpc/server'

import {
  appendSupportMessageAction,
  createSupportRequestAction,
  SupportActionError,
} from '@pathfinder/db'

import { router } from '../core'
import {
  AddClientSupportMessageInput,
  CreateSupportRequestInput,
  EligibleSupportAttachmentsInput,
  GetSupportRequestInput,
  SupportPageInput,
} from '../schemas/support'
import { tenantProcedure } from '../trpc'
import { INTAKE_UPLOAD_MAX_BYTES, IntakeUploadMimeType } from '@pathfinder/contracts/intake-upload'

const clientRequestSelect = {
  id: true,
  venueId: true,
  category: true,
  status: true,
  subject: true,
  missingInformation: true,
  version: true,
  statusChangedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

const clientMessageSelect = {
  id: true,
  authorKind: true,
  visibility: true,
  body: true,
  createdAt: true,
  attachments: {
    select: {
      id: true,
      filename: true,
      mediaType: true,
      byteSize: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const

function cursorWhere(cursor: { updatedAt: string; id: string } | undefined) {
  if (!cursor) return {}
  const updatedAt = new Date(cursor.updatedAt)
  return {
    AND: [{ OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: cursor.id } }] }],
  }
}

function serializeMessage<T extends { attachments: Array<{ byteSize: bigint }> }>(message: T) {
  return {
    ...message,
    attachments: message.attachments.map((attachment) => ({
      ...attachment,
      byteSize: attachment.byteSize.toString(),
    })),
  }
}

function serializeClientMessage<
  T extends {
    id: string
    authorKind: string
    visibility: string
    body: string
    createdAt: Date
    attachments: Array<{
      id: string
      filename: string
      mediaType: string
      byteSize: bigint
    }>
  },
>(message: T) {
  return {
    id: message.id,
    authorKind: message.authorKind,
    visibility: message.visibility,
    body: message.body,
    createdAt: message.createdAt,
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      byteSize: attachment.byteSize.toString(),
    })),
  }
}

function supportActionError(error: unknown): never {
  if (error instanceof SupportActionError)
    throw new TRPCError({
      code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
      message: error.message,
    })
  throw error
}

export const supportRouter = router({
  listEligibleAttachments: tenantProcedure
    .input(EligibleSupportAttachmentsInput)
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.intakeUpload.findMany({
        where: {
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          status: 'AWAITING_REVIEW',
          mimeType: { in: IntakeUploadMimeType.options },
          byteSize: { gte: 1, lte: INTAKE_UPLOAD_MAX_BYTES },
          requestedBy: ctx.session.userId,
          verifiedAt: { not: null },
          storageVersionId: { not: null },
          intakeRunId: { not: null },
          intakeRun: { sourceKind: 'FILE_UPLOAD', status: 'AWAITING_REVIEW' },
          ...(input.cursor
            ? {
                OR: [
                  { createdAt: { lt: new Date(input.cursor.createdAt) } },
                  { createdAt: new Date(input.cursor.createdAt), id: { lt: input.cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          byteSize: true,
          sha256: true,
          verifiedAt: true,
          storageVersionId: true,
          intakeRunId: true,
          intakeRun: {
            select: {
              id: true,
              sourceKind: true,
              status: true,
              evidence: {
                select: {
                  tenantId: true,
                  venueId: true,
                  runId: true,
                  sourceKind: true,
                  locator: true,
                  normalizedHash: true,
                },
              },
            },
          },
          createdAt: true,
        },
      })
      const eligible = rows.filter(
        (upload) =>
          upload.verifiedAt &&
          upload.storageVersionId &&
          upload.intakeRunId &&
          upload.intakeRun?.id === upload.intakeRunId &&
          upload.intakeRun.sourceKind === 'FILE_UPLOAD' &&
          upload.intakeRun.status === 'AWAITING_REVIEW' &&
          IntakeUploadMimeType.safeParse(upload.mimeType).success &&
          upload.byteSize >= 1 &&
          upload.byteSize <= INTAKE_UPLOAD_MAX_BYTES &&
          upload.intakeRun.evidence.length === 1 &&
          upload.intakeRun.evidence[0]?.tenantId === ctx.session.activeTenantId &&
          upload.intakeRun.evidence[0]?.venueId === input.venueId &&
          upload.intakeRun.evidence[0]?.runId === upload.intakeRunId &&
          upload.intakeRun.evidence[0]?.sourceKind === 'FILE_UPLOAD' &&
          upload.intakeRun.evidence[0]?.locator === `intake-upload:${upload.id}` &&
          upload.intakeRun.evidence[0]?.normalizedHash === upload.sha256,
      )
      const included = eligible.slice(0, input.limit)
      const items = included.map((upload) => ({
        intakeUploadId: upload.id,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        byteSize: upload.byteSize,
        createdAt: upload.createdAt,
      }))
      const lastIncluded = included.at(-1)
      const cursorRow =
        included.length === input.limit
          ? lastIncluded
          : rows.length === input.limit + 1
            ? rows.at(-1)
            : null
      return {
        items,
        nextCursor: cursorRow
          ? { createdAt: cursorRow.createdAt.toISOString(), id: cursorRow.id }
          : null,
      }
    }),

  listRequests: tenantProcedure.input(SupportPageInput).query(async ({ ctx, input }) => {
    const tenantId = ctx.session.activeTenantId
    const rows = await ctx.db.supportRequest.findMany({
      where: {
        tenantId,
        venueId: input.venueId,
        ...cursorWhere(input.cursor),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: clientRequestSelect,
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

  getRequest: tenantProcedure.input(GetSupportRequestInput).query(async ({ ctx, input }) => {
    const tenantId = ctx.session.activeTenantId
    const request = await ctx.db.supportRequest.findFirst({
      where: { id: input.requestId, tenantId, venueId: input.venueId },
      select: {
        ...clientRequestSelect,
        messages: {
          where: {
            tenantId,
            venueId: input.venueId,
            visibility: 'CLIENT_VISIBLE',
            ...(input.messageCursor
              ? {
                  AND: [
                    {
                      OR: [
                        { createdAt: { gt: new Date(input.messageCursor.createdAt) } },
                        {
                          createdAt: new Date(input.messageCursor.createdAt),
                          id: { gt: input.messageCursor.id },
                        },
                      ],
                    },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: input.messageLimit + 1,
          select: clientMessageSelect,
        },
      },
    })
    if (!request) throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request not found' })
    const messages = request.messages.slice(0, input.messageLimit)
    const last = messages.at(-1)
    return {
      ...request,
      messages: messages.map(serializeMessage),
      nextMessageCursor:
        request.messages.length > input.messageLimit && last
          ? { createdAt: last.createdAt.toISOString(), id: last.id }
          : null,
    }
  }),

  createRequest: tenantProcedure
    .input(CreateSupportRequestInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      try {
        const result = await createSupportRequestAction(
          {
            operationId: input.operationId,
            tenantId,
            venueId: input.venueId,
            category: input.category,
            subject: input.subject,
            body: input.body,
            attachments: input.attachments,
            actor: {
              actorType: 'HUMAN',
              participantKind: 'CLIENT',
              actorId: ctx.session.userId,
              auditRole: ctx.session.role ?? 'STAFF',
            },
          },
          ctx.db,
        )
        return {
          request: result.request,
          message: serializeClientMessage(result.message),
          replayed: result.replayed,
        }
      } catch (error) {
        return supportActionError(error)
      }
    }),

  addMessage: tenantProcedure
    .input(AddClientSupportMessageInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      try {
        const result = await appendSupportMessageAction(
          {
            operationId: input.operationId,
            tenantId,
            venueId: input.venueId,
            requestId: input.requestId,
            expectedVersion: input.expectedVersion,
            visibility: 'CLIENT_VISIBLE',
            body: input.body,
            attachments: input.attachments,
            actor: {
              actorType: 'HUMAN',
              participantKind: 'CLIENT',
              actorId: ctx.session.userId,
              auditRole: ctx.session.role ?? 'STAFF',
            },
          },
          ctx.db,
        )
        return {
          message: serializeClientMessage(result.message),
          requestVersion: result.requestVersion,
          replayed: result.replayed,
        }
      } catch (error) {
        return supportActionError(error)
      }
    }),
})
