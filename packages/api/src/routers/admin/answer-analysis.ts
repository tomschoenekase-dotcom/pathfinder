import { randomUUID } from 'node:crypto'

import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { logger } from '@pathfinder/config/logger'
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { enqueueGenerationDispatchKick } from '@pathfinder/jobs'

import { router } from '../../core'
import { generationRequestHash } from '../../lib/generation-request-identity'
import { adminAiProcedure, adminProcedure } from '../../trpc'
import { isUniqueConstraintError } from './helpers'

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
      const requestHash = generationRequestHash({
        kind: 'ANSWER_ANALYSIS',
        venueId: input.venueId,
        rangeStart,
        rangeEnd,
      })

      const createOrReplay = () =>
        withTenantIsolationBypass(() =>
          db.$transaction(async (transaction) => {
            const existing = await transaction.generationRequestDispatch.findFirst({
              where: {
                tenantId: input.tenantId,
                kind: 'ANSWER_ANALYSIS',
                requestId: input.requestId,
              },
              select: { id: true, recordId: true, requestHash: true, status: true },
            })
            if (existing) {
              if (existing.requestHash !== requestHash) {
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'Request ID was already used for different analysis input.',
                })
              }
              return { ...existing, replayed: true }
            }

            const venue = await transaction.venue.findFirst({
              where: { id: input.venueId, tenantId: input.tenantId },
              select: { id: true },
            })
            if (!venue) {
              throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
            }

            const snapshotId = randomUUID()
            const dispatchId = randomUUID()
            await transaction.answerAnalysisSnapshot.create({
              data: {
                id: snapshotId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                rangeStart,
                rangeEnd,
                status: 'GENERATING',
                createdBy: ctx.session.userId,
              },
            })
            const dispatch = await transaction.generationRequestDispatch.create({
              data: {
                id: dispatchId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                kind: 'ANSWER_ANALYSIS',
                requestId: input.requestId,
                requestHash,
                recordId: snapshotId,
                rangeStart,
                rangeEnd,
                answerAnalysisSnapshotId: snapshotId,
              },
              select: { id: true, recordId: true, requestHash: true, status: true },
            })
            await transaction.auditLog.create({
              data: {
                tenantId: input.tenantId,
                actorId: ctx.session.userId,
                actorRole: 'PLATFORM_ADMIN',
                action: 'admin.answer_analysis.requested',
                targetType: 'AnswerAnalysisSnapshot',
                targetId: snapshotId,
                afterState: {
                  venueId: input.venueId,
                  rangeStart: rangeStart.toISOString(),
                  rangeEnd: rangeEnd.toISOString(),
                  requestId: input.requestId,
                },
              },
            })
            return { ...dispatch, replayed: false }
          }),
        )

      let durableRequest
      try {
        durableRequest = await createOrReplay()
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error
        durableRequest = await createOrReplay()
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
