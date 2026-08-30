import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { logger } from '@pathfinder/config/logger'
import {
  db,
  publishWeeklyReportAction,
  updateWeeklyReportDraftAction,
  WeeklyReportActionError,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { enqueueGenerationDispatchKick } from '@pathfinder/jobs'

import { router } from '../../core'
import {
  requestWeeklyReportDraftAction,
  WeeklyReportGenerationError,
} from '../../lib/weekly-report-generation'
import { adminAiProcedure, adminProcedure } from '../../trpc'

function reportActor(userId: string) {
  return { type: 'HUMAN' as const, id: userId, role: 'PLATFORM_ADMIN' as const }
}

function mapWeeklyReportActionError(error: unknown): never {
  if (!(error instanceof WeeklyReportActionError)) throw error
  throw new TRPCError({
    code:
      error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.code === 'CONFLICT'
          ? 'CONFLICT'
          : error.code === 'PRECONDITION_FAILED'
            ? 'PRECONDITION_FAILED'
            : 'BAD_REQUEST',
    message: error.message,
    cause: error,
  })
}

export const adminWeeklyReportsRouter = router({
  generateWeeklyReportDraft: adminAiProcedure
    .input(
      z.object({
        tenantId: z.string(),
        venueId: z.string(),
        weekStart: z.string().datetime(),
        weekEnd: z.string().datetime(),
        title: z.string().min(1).max(200).optional(),
        requestId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const weekStart = new Date(input.weekStart)
      const weekEnd = new Date(input.weekEnd)
      let durableRequest
      try {
        durableRequest = await requestWeeklyReportDraftAction({
          tenantId: input.tenantId,
          venueId: input.venueId,
          weekStart,
          weekEnd,
          ...(input.title === undefined ? {} : { title: input.title }),
          requestId: input.requestId,
          actor: { id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
      } catch (error) {
        if (!(error instanceof WeeklyReportGenerationError)) throw error
        throw new TRPCError({
          code:
            error.code === 'NOT_FOUND'
              ? 'NOT_FOUND'
              : error.code === 'CONFLICT'
                ? 'CONFLICT'
                : error.code === 'PRECONDITION_FAILED'
                  ? 'PRECONDITION_FAILED'
                  : 'BAD_REQUEST',
          message: error.message,
        })
      }

      if (durableRequest.dispatchState === 'PENDING' && durableRequest.enqueueAllowed) {
        try {
          await enqueueGenerationDispatchKick(durableRequest.dispatchId)
        } catch {
          logger.warn({
            action: 'admin.weekly-report.dispatch-kick.failed',
            tenantId: input.tenantId,
            venueId: input.venueId,
            reportId: durableRequest.reportId,
            error: 'Durable report request is pending dispatcher retry.',
          })
        }
      }

      return {
        reportId: durableRequest.reportId,
        requestId: input.requestId,
        dispatchState: durableRequest.dispatchState,
        replayed: durableRequest.replayed,
      }
    }),

  listWeeklyReports: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          limit: z.number().int().min(1).max(50).default(25),
          cursorWeekStart: z.string().datetime().optional(),
          cursorId: z.string().min(1).max(191).optional(),
        })
        .strict()
        .refine((value) => Boolean(value.cursorWeekStart) === Boolean(value.cursorId), {
          message: 'Report cursor fields must be supplied together.',
        }),
    )
    .query(async ({ input }) =>
      withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        const cursorWeekStart = input.cursorWeekStart ? new Date(input.cursorWeekStart) : undefined
        const reports = await db.weeklyReport.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(cursorWeekStart && input.cursorId
              ? {
                  OR: [
                    { weekStart: { lt: cursorWeekStart } },
                    { weekStart: cursorWeekStart, id: { lt: input.cursorId } },
                  ],
                }
              : {}),
          },
          orderBy: [{ weekStart: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            weekStart: true,
            weekEnd: true,
            status: true,
            title: true,
            publishedAt: true,
            updatedAt: true,
          },
        })
        const hasMore = reports.length > input.limit
        const items = reports.slice(0, input.limit)
        const tail = hasMore ? items.at(-1) : undefined
        return {
          items,
          nextCursor: tail ? { weekStart: tail.weekStart.toISOString(), id: tail.id } : null,
        }
      }),
    ),

  getWeeklyReport: adminProcedure
    .input(z.object({ tenantId: z.string(), venueId: z.string(), reportId: z.string() }))
    .query(async ({ input }) => {
      const report = await withTenantIsolationBypass(async () =>
        db.weeklyReport.findFirst({
          where: {
            id: input.reportId,
            tenantId: input.tenantId,
            venueId: input.venueId,
          },
        }),
      )
      if (!report) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' })
      return report
    }),

  updateWeeklyReportDraft: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        venueId: z.string(),
        reportId: z.string(),
        expectedUpdatedAt: z.string().datetime(),
        title: z.string().min(1).max(200).optional(),
        content: z.string().min(1).max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          updateWeeklyReportDraftAction(
            {
              tenantId: input.tenantId,
              venueId: input.venueId,
              reportId: input.reportId,
              expectedUpdatedAt: new Date(input.expectedUpdatedAt),
              ...(input.title !== undefined ? { title: input.title } : {}),
              content: input.content,
              actor: reportActor(ctx.session.userId),
            },
            db,
          ),
        )
      } catch (error) {
        mapWeeklyReportActionError(error)
      }
    }),

  publishWeeklyReport: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string(),
          venueId: z.string(),
          reportId: z.string(),
          expectedUpdatedAt: z.string().datetime(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          publishWeeklyReportAction(
            {
              tenantId: input.tenantId,
              venueId: input.venueId,
              reportId: input.reportId,
              expectedUpdatedAt: new Date(input.expectedUpdatedAt),
              actor: reportActor(ctx.session.userId),
            },
            db,
          ),
        )
      } catch (error) {
        mapWeeklyReportActionError(error)
      }
    }),
})
