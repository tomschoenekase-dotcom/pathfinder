import { TRPCError } from '@trpc/server'

import {
  appendSupportMessageAction,
  canTenantActorAccessSupportRequest,
  createSupportRequestAction,
  grantSupportRequestParticipantAction,
  revokeSupportRequestParticipantAction,
  respondToSupportInformationAction,
  SupportActionError,
  tenantSupportRequestAccessWhere,
  type TenantSupportRole,
} from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import {
  AddClientSupportMessageInput,
  CreateSupportRequestInput,
  EligibleSupportAttachmentsInput,
  GetSupportRequestInput,
  ListSupportParticipantCandidatesInput,
  ManageSupportParticipantInput,
  RespondToSupportInformationInput,
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
  clientVersion: true,
  clientActivityAt: true,
  statusChangedAt: true,
  createdAt: true,
  createdByKind: true,
  requesterUserId: true,
  requesterMembership: { select: { status: true } },
  participants: {
    select: {
      userId: true,
      revokedAt: true,
      membership: { select: { status: true } },
    },
  },
} as const

const clientMessageSelect = {
  id: true,
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
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const

function cursorWhere(cursor: { clientActivityAt: string; id: string } | undefined) {
  if (!cursor) return {}
  const clientActivityAt = new Date(cursor.clientActivityAt)
  return {
    AND: [
      {
        OR: [
          { clientActivityAt: { lt: clientActivityAt } },
          { clientActivityAt, id: { lt: cursor.id } },
        ],
      },
    ],
  }
}

function serializeClientMessage<
  T extends {
    id: string
    authorKind: string
    authorId: string
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
>(message: T, currentUserId: string) {
  return {
    id: message.id,
    authorKind: message.authorKind,
    authorIsCurrentUser: message.authorId === currentUserId,
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

function tenantActor(session: TRPCContext['session']): {
  actorId: string
  role: TenantSupportRole
} {
  if (!session.role) throw new TRPCError({ code: 'FORBIDDEN', message: 'Tenant role required' })
  return { actorId: session.userId, role: session.role }
}

function serializeClientRequest<
  T extends {
    status: string
    createdByKind: string
    requesterUserId: string | null
    requesterMembership: { status: string } | null
    participants: Array<{
      userId: string
      revokedAt: Date | null
      membership: { status: string }
    }>
  },
>(request: T, actor: { actorId: string; role: TenantSupportRole }) {
  const { createdByKind, requesterUserId, requesterMembership, participants, ...safe } = request
  const authorized = canTenantActorAccessSupportRequest(actor, {
    createdByKind,
    requesterUserId,
    requesterMembership,
    participants,
  })
  return {
    ...safe,
    requesterIsCurrentUser: createdByKind === 'CLIENT' && requesterUserId === actor.actorId,
    participantIsCurrentUser: participants.some(
      (participant) => participant.userId === actor.actorId && participant.revokedAt === null,
    ),
    canReply: authorized && request.status !== 'COMPLETED' && request.status !== 'CANCELLED',
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
  listParticipantCandidates: tenantProcedure
    .input(ListSupportParticipantCandidatesInput)
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const userId = ctx.session.userId
      return ctx.db.$transaction(
        async (tx) => {
          const request = await tx.supportRequest.findFirst({
            where: {
              id: input.requestId,
              tenantId,
              venueId: input.venueId,
              createdByKind: 'CLIENT',
              requesterUserId: userId,
              requesterMembership: { is: { status: 'ACTIVE' } },
            },
            select: {
              id: true,
              requesterUserId: true,
            },
          })
          if (!request)
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request not found' })

          const memberships = await tx.tenantMembership.findMany({
            where: {
              tenantId,
              status: 'ACTIVE',
              userId: { not: request.requesterUserId ?? userId },
            },
            orderBy: { userId: 'asc' },
            take: input.limit + 1,
            ...(input.cursor
              ? { cursor: { tenantId_userId: { tenantId, userId: input.cursor } }, skip: 1 }
              : {}),
            select: { userId: true, user: { select: { fullName: true } } },
          })
          const page = memberships.slice(0, input.limit)
          const activeParticipants = page.length
            ? await tx.supportRequestParticipant.findMany({
                where: {
                  tenantId,
                  venueId: input.venueId,
                  supportRequestId: input.requestId,
                  userId: { in: page.map((membership) => membership.userId) },
                  revokedAt: null,
                },
                select: { userId: true },
              })
            : []
          const activeParticipantIds = new Set(
            activeParticipants.map((participant) => participant.userId),
          )
          return {
            candidates: page.map((membership) => ({
              userId: membership.userId,
              displayLabel: membership.user.fullName?.trim().slice(0, 120) || 'Team member',
              activeOnRequest: activeParticipantIds.has(membership.userId),
            })),
            nextCursor: memberships.length > input.limit ? page.at(-1)!.userId : null,
          }
        },
        { isolationLevel: 'RepeatableRead' },
      )
    }),

  listEligibleAttachments: tenantProcedure
    .input(EligibleSupportAttachmentsInput)
    .query(async ({ ctx, input }) => {
      if (!ctx.session.isPlatformAdmin) {
        const membership = await ctx.db.tenantMembership.findFirst({
          where: {
            tenantId: ctx.session.activeTenantId,
            userId: ctx.session.userId,
            status: 'ACTIVE',
          },
          select: { id: true },
        })
        if (!membership)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Eligible attachments not found' })
      }
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
          AND: [
            { verificationReceipts: { some: { kind: 'PRECHECK', verdict: 'PASSED' } } },
            { verificationReceipts: { some: { kind: 'RESOURCE_SAFETY', verdict: 'PASSED' } } },
            { verificationReceipts: { some: { kind: 'MALWARE', verdict: 'CLEAN' } } },
          ],
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
    const actor = tenantActor(ctx.session)
    const rows = await ctx.db.supportRequest.findMany({
      where: {
        tenantId,
        venueId: input.venueId,
        ...tenantSupportRequestAccessWhere(actor),
        ...cursorWhere(input.cursor),
      },
      orderBy: [{ clientActivityAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        ...clientRequestSelect,
        participants: {
          where: { userId: actor.actorId },
          take: 1,
          select: {
            userId: true,
            revokedAt: true,
            membership: { select: { status: true } },
          },
        },
      },
    })
    const items = rows
      .slice(0, input.limit)
      .map((request) => serializeClientRequest(request, actor))
    const last = items.at(-1)
    return {
      items,
      nextCursor:
        rows.length > input.limit && last
          ? { clientActivityAt: last.clientActivityAt.toISOString(), id: last.id }
          : null,
    }
  }),

  getRequest: tenantProcedure.input(GetSupportRequestInput).query(async ({ ctx, input }) => {
    const tenantId = ctx.session.activeTenantId
    const actor = tenantActor(ctx.session)
    const request = await ctx.db.supportRequest.findFirst({
      where: {
        id: input.requestId,
        tenantId,
        venueId: input.venueId,
        ...tenantSupportRequestAccessWhere(actor),
      },
      select: {
        ...clientRequestSelect,
        participants: {
          where: { userId: actor.actorId },
          take: 1,
          select: {
            userId: true,
            revokedAt: true,
            membership: { select: { status: true } },
          },
        },
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
    const pageMessages = request.messages.slice(0, input.messageLimit)
    const last = pageMessages.at(-1)
    const { messages: allMessages, ...requestWithoutMessages } = request
    void allMessages
    return {
      ...serializeClientRequest(requestWithoutMessages, actor),
      messages: pageMessages.map((message) => serializeClientMessage(message, actor.actorId)),
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
      const actor = tenantActor(ctx.session)
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
              actorId: actor.actorId,
              auditRole: actor.role,
            },
          },
          ctx.db,
        )
        const { version, updatedAt, ...clientRequest } = result.request
        void version
        void updatedAt
        return {
          request: {
            ...clientRequest,
            requesterIsCurrentUser: true,
            participantIsCurrentUser: false,
            canReply:
              result.request.status !== 'COMPLETED' && result.request.status !== 'CANCELLED',
          },
          message: serializeClientMessage(result.message, actor.actorId),
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
      const actor = tenantActor(ctx.session)
      try {
        const result = await appendSupportMessageAction(
          {
            operationId: input.operationId,
            tenantId,
            venueId: input.venueId,
            requestId: input.requestId,
            expectedClientVersion: input.expectedClientVersion,
            visibility: 'CLIENT_VISIBLE',
            body: input.body,
            attachments: input.attachments,
            actor: {
              actorType: 'HUMAN',
              participantKind: 'CLIENT',
              actorId: actor.actorId,
              auditRole: actor.role,
            },
          },
          ctx.db,
        )
        return {
          message: serializeClientMessage(result.message, actor.actorId),
          clientVersion: result.clientVersion,
          replayed: result.replayed,
        }
      } catch (error) {
        return supportActionError(error)
      }
    }),

  respondToInformation: tenantProcedure
    .input(RespondToSupportInformationInput)
    .mutation(async ({ ctx, input }) => {
      const actor = tenantActor(ctx.session)
      try {
        const result = await respondToSupportInformationAction(
          {
            ...input,
            tenantId: ctx.session.activeTenantId,
            actor: {
              actorType: 'HUMAN',
              participantKind: 'CLIENT',
              actorId: actor.actorId,
              auditRole: actor.role,
            },
          },
          ctx.db,
        )
        return {
          ...result,
          message: serializeClientMessage(result.message, actor.actorId),
        }
      } catch (error) {
        return supportActionError(error)
      }
    }),

  grantParticipant: tenantProcedure
    .input(ManageSupportParticipantInput)
    .mutation(async ({ ctx, input }) => {
      const actor = tenantActor(ctx.session)
      try {
        const result = await grantSupportRequestParticipantAction(
          {
            ...input,
            tenantId: ctx.session.activeTenantId,
            actor: {
              actorType: 'HUMAN',
              participantKind: 'CLIENT',
              actorId: actor.actorId,
              auditRole: actor.role,
            },
          },
          ctx.db,
        )
        return {
          requestVersion: result.requestVersion,
          clientVersion: result.clientVersion,
          actionAt: result.actionAt,
          active: result.active,
          replayed: result.replayed,
        }
      } catch (error) {
        return supportActionError(error)
      }
    }),

  revokeParticipant: tenantProcedure
    .input(ManageSupportParticipantInput)
    .mutation(async ({ ctx, input }) => {
      const actor = tenantActor(ctx.session)
      try {
        const result = await revokeSupportRequestParticipantAction(
          {
            ...input,
            tenantId: ctx.session.activeTenantId,
            actor: {
              actorType: 'HUMAN',
              participantKind: 'CLIENT',
              actorId: actor.actorId,
              auditRole: actor.role,
            },
          },
          ctx.db,
        )
        return {
          requestVersion: result.requestVersion,
          clientVersion: result.clientVersion,
          actionAt: result.actionAt,
          active: result.active,
          replayed: result.replayed,
        }
      } catch (error) {
        return supportActionError(error)
      }
    }),
})
