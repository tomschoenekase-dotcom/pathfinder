import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { logger } from '@pathfinder/config/logger'
import {
  AnswerAnalysisRequestActionError,
  db,
  requestAnswerAnalysisAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { enqueueGenerationDispatchKick } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminAiProcedure, adminProcedure } from '../../trpc'

function mapRequestError(error: unknown): never {
  if (error instanceof AnswerAnalysisRequestActionError) {
    throw new TRPCError({
      code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
      message: error.message,
      cause: error,
    })
  }
  throw error
}

export const adminAnswerAnalysisRouter = router({
  generateAnswerAnalysis: adminAiProcedure
    .input(
      z.object({
        tenantId: z.string(),
        venueId: z.string(),
        rangeStart: z.string().datetime(),
        rangeEnd: z.string().datetime(),
        requestId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rangeStart = new Date(input.rangeStart)
      const rangeEnd = new Date(input.rangeEnd)
      let durableRequest
      try {
        durableRequest = await withTenantIsolationBypass(() =>
          requestAnswerAnalysisAction(
            {
              tenantId: input.tenantId,
              venueId: input.venueId,
              rangeStart,
              rangeEnd,
              requestId: input.requestId,
              actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
            },
            db,
          ),
        )
      } catch (error) {
        mapRequestError(error)
      }

      if (durableRequest.status === 'PENDING') {
        try {
          await enqueueGenerationDispatchKick(durableRequest.id)
        } catch {
          logger.warn({
            action: 'admin.answer-analysis.dispatch-kick.failed',
            tenantId: input.tenantId,
            venueId: input.venueId,
            snapshotId: durableRequest.recordId,
            error: 'Durable analysis request is pending dispatcher retry.',
          })
        }
      }

      return {
        snapshotId: durableRequest.recordId,
        requestId: input.requestId,
        dispatchState: durableRequest.status,
        replayed: durableRequest.replayed,
      }
    }),

  listAnswerAnalyses: adminProcedure
    .input(z.object({ tenantId: z.string(), venueId: z.string() }))
    .query(async ({ input }) =>
      withTenantIsolationBypass(async () =>
        db.answerAnalysisSnapshot.findMany({
          where: { tenantId: input.tenantId, venueId: input.venueId },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            status: true,
            rangeStart: true,
            rangeEnd: true,
            answerCount: true,
            generatedAt: true,
          },
        }),
      ),
    ),

  getAnswerAnalysis: adminProcedure
    .input(z.object({ tenantId: z.string(), venueId: z.string(), snapshotId: z.string() }))
    .query(async ({ input }) => {
      const snapshot = await withTenantIsolationBypass(async () =>
        db.answerAnalysisSnapshot.findFirst({
          where: {
            id: input.snapshotId,
            tenantId: input.tenantId,
            venueId: input.venueId,
          },
        }),
      )
      if (!snapshot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Analysis not found' })
      return snapshot
    }),
})
