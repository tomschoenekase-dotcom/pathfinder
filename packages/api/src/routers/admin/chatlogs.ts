import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import {
  addChatlogNoteAction,
  ChatlogReviewActionError,
  db,
  setChatlogNotableAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

function mapActionError(error: unknown): never {
  if (error instanceof ChatlogReviewActionError) {
    throw new TRPCError({
      code:
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'BAD_REQUEST',
      message: error.message,
    })
  }
  throw error
}

export const adminChatlogsRouter = router({
  listVenueSessions: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        venueId: z.string(),
        dateFrom: z.string().datetime().optional(),
        dateTo: z.string().datetime().optional(),
        notableOnly: z.boolean().optional(),
        experienceScope: z.enum(['PUBLIC', 'SECOND_LAYER']).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    )
    .query(async ({ input }) => {
      return withTenantIsolationBypass(async () => {
        const sessions = await db.visitorSession.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(input.experienceScope ? { experienceScope: input.experienceScope } : {}),
            ...(input.notableOnly ? { isNotable: true } : {}),
            ...(input.dateFrom || input.dateTo
              ? {
                  startedAt: {
                    ...(input.dateFrom ? { gte: new Date(input.dateFrom) } : {}),
                    ...(input.dateTo ? { lte: new Date(input.dateTo) } : {}),
                  },
                }
              : {}),
          },
          orderBy: { startedAt: 'desc' },
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          select: {
            id: true,
            startedAt: true,
            lastActiveAt: true,
            isNotable: true,
            experienceScope: true,
            _count: {
              select: {
                messages: { where: { role: 'user' } },
                engagementResponses: true,
                adminNotes: true,
              },
            },
          },
        })

        const hasMore = sessions.length > input.limit
        return {
          sessions: sessions
            .slice(0, input.limit)
            .map(({ _count: { messages, ...counts }, ...session }) => ({
              ...session,
              messageCount: messages,
              _count: counts,
            })),
          nextCursor: hasMore ? (sessions[input.limit]?.id ?? null) : null,
        }
      })
    }),

  getSessionChatlog: adminProcedure
    .input(z.object({ tenantId: z.string(), venueId: z.string(), sessionId: z.string() }))
    .query(async ({ input }) => {
      return withTenantIsolationBypass(async () => {
        const session = await db.visitorSession.findFirst({
          where: {
            id: input.sessionId,
            tenantId: input.tenantId,
            venueId: input.venueId,
          },
          select: {
            id: true,
            venueId: true,
            startedAt: true,
            lastActiveAt: true,
            isNotable: true,
            experienceScope: true,
            venue: { select: { name: true } },
            messages: {
              orderBy: { createdAt: 'asc' },
              select: { id: true, role: true, content: true, createdAt: true },
            },
            engagementResponses: {
              orderBy: { askedAt: 'asc' },
              select: {
                id: true,
                questionText: true,
                answerText: true,
                answerType: true,
                isAiInvented: true,
                askedAt: true,
                answeredAt: true,
              },
            },
            adminNotes: {
              orderBy: { createdAt: 'desc' },
              select: { id: true, note: true, authorId: true, createdAt: true },
            },
          },
        })

        if (!session) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' })
        }

        return session
      })
    }),

  setSessionNotable: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        venueId: z.string(),
        sessionId: z.string(),
        isNotable: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await withTenantIsolationBypass(() =>
          setChatlogNotableAction(
            {
              ...input,
              actor: {
                type: 'HUMAN',
                id: ctx.session.userId,
                role: 'PLATFORM_ADMIN',
              },
            },
            db,
          ),
        )
        return { ok: true }
      } catch (error) {
        mapActionError(error)
      }
    }),

  addChatlogNote: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        venueId: z.string(),
        sessionId: z.string(),
        requestId: z.string().uuid(),
        note: z.string().trim().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const created = await withTenantIsolationBypass(() =>
          addChatlogNoteAction(
            {
              ...input,
              actor: {
                type: 'HUMAN',
                id: ctx.session.userId,
                role: 'PLATFORM_ADMIN',
              },
            },
            db,
          ),
        )
        return {
          id: created.id,
          note: created.note,
          authorId: created.authorId,
          createdAt: created.createdAt,
        }
      } catch (error) {
        mapActionError(error)
      }
    }),
})
