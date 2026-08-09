import { randomUUID } from 'node:crypto'

import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { logger } from '@pathfinder/config/logger'
import { db, lockVenueReportMutation, withTenantIsolationBypass } from '@pathfinder/db'
import { enqueueGenerationDispatchKick } from '@pathfinder/jobs'

import { router } from '../../core'
import {
  effectiveWeeklyReportTitle,
  generationRequestHash,
} from '../../lib/generation-request-identity'
import { findVenueReportConfiguration } from '../../lib/venue-report-configuration'
import { adminAiProcedure, adminProcedure } from '../../trpc'
import { isUniqueConstraintError } from './helpers'

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

      const title = effectiveWeeklyReportTitle(input.title)
      const requestHash = generationRequestHash({
        kind: 'WEEKLY_REPORT',
        venueId: input.venueId,
        rangeStart: weekStart,
        rangeEnd: weekEnd,
        title,
      })
      const createOrReplay = () =>
        withTenantIsolationBypass(() =>
          db.$transaction(async (transaction) => {
            await lockVenueReportMutation(transaction, input)
            const venue = await transaction.venue.findFirst({
              where: { id: input.venueId, tenantId: input.tenantId },
              select: { id: true, isActive: true },
            })
            if (!venue) {
              throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
            }
            if (venue.isActive === false) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'This venue is temporarily unavailable.',
              })
            }

            const existing = await transaction.generationRequestDispatch.findFirst({
              where: {
                tenantId: input.tenantId,
                kind: 'WEEKLY_REPORT',
                requestId: input.requestId,
              },
              select: { id: true, recordId: true, requestHash: true, status: true },
            })
            if (existing) {
              if (existing.requestHash !== requestHash) {
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'Request ID was already used for different report input.',
                })
              }
              const configuration = await findVenueReportConfiguration(
                transaction,
                input.tenantId,
                input.venueId,
              )
              return {
                ...existing,
                replayed: true,
                enqueueAllowed: configuration?.enabled === true,
              }
            }

            const configuration = await findVenueReportConfiguration(
              transaction,
              input.tenantId,
              input.venueId,
            )
            if (configuration?.enabled !== true) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'Weekly reports are disabled for this venue.',
              })
            }

            const reportId = randomUUID()
            const dispatchId = randomUUID()
            await transaction.weeklyReport.create({
              data: {
                id: reportId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                weekStart,
                weekEnd,
                status: 'GENERATING',
                title,
                createdBy: ctx.session.userId,
              },
            })
            const dispatch = await transaction.generationRequestDispatch.create({
              data: {
                id: dispatchId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                kind: 'WEEKLY_REPORT',
                requestId: input.requestId,
                requestHash,
                recordId: reportId,
                rangeStart: weekStart,
                rangeEnd: weekEnd,
                weeklyReportId: reportId,
              },
              select: { id: true, recordId: true, requestHash: true, status: true },
            })
            await transaction.auditLog.create({
              data: {
                tenantId: input.tenantId,
                actorId: ctx.session.userId,
                actorRole: 'PLATFORM_ADMIN',
                action: 'admin.report.requested',
                targetType: 'WeeklyReport',
                targetId: reportId,
                afterState: {
                  venueId: input.venueId,
                  weekStart: weekStart.toISOString(),
                  weekEnd: weekEnd.toISOString(),
                  requestId: input.requestId,
                },
              },
            })
            return { ...dispatch, replayed: false, enqueueAllowed: true }
          }),
        )

      let durableRequest
      try {
        durableRequest = await createOrReplay()
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error
        durableRequest = await createOrReplay()
      }

      if (durableRequest.status === 'PENDING' && durableRequest.enqueueAllowed) {
        try {
          await enqueueGenerationDispatchKick(durableRequest.id)
        } catch {
          logger.warn({
            action: 'admin.weekly-report.dispatch-kick.failed',
            tenantId: input.tenantId,
            venueId: input.venueId,
            reportId: durableRequest.recordId,
            error: 'Durable report request is pending dispatcher retry.',
          })
        }
      }

      return {
        reportId: durableRequest.recordId,
        requestId: input.requestId,
        dispatchState: durableRequest.status,
        replayed: durableRequest.replayed,
      }
    }),

  listWeeklyReports: adminProcedure
    .input(z.object({ tenantId: z.string(), venueId: z.string() }))
    .query(async ({ input }) =>
      withTenantIsolationBypass(async () =>
        db.weeklyReport.findMany({
          where: { tenantId: input.tenantId, venueId: input.venueId },
          orderBy: { weekStart: 'desc' },
          select: {
            id: true,
            weekStart: true,
            weekEnd: true,
            status: true,
            title: true,
            publishedAt: true,
            updatedAt: true,
          },
        }),
      ),
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
      return withTenantIsolationBypass(() =>
        db.$transaction(async (transaction) => {
          await lockVenueReportMutation(transaction, input)
          const existing = await transaction.weeklyReport.findFirst({
            where: {
              id: input.reportId,
              tenantId: input.tenantId,
              venueId: input.venueId,
            },
            select: { status: true, updatedAt: true },
          })
          if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' })
          if (existing.status !== 'DRAFT') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Only a draft report can be edited.',
            })
          }

          const expectedUpdatedAt = new Date(input.expectedUpdatedAt)
          if (existing.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'This report was edited elsewhere. Reload it before saving again.',
            })
          }

          // Make each successful draft-save token strictly newer than the token it consumed,
          // even when two operations fall in the same clock millisecond.
          const nextUpdatedAt = new Date(Math.max(Date.now(), expectedUpdatedAt.getTime() + 1))
          const updated = await transaction.weeklyReport.updateMany({
            where: {
              id: input.reportId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              status: 'DRAFT',
              updatedAt: expectedUpdatedAt,
            },
            data: {
              content: input.content,
              updatedAt: nextUpdatedAt,
              ...(input.title !== undefined ? { title: input.title } : {}),
            },
          })
          if (updated.count !== 1) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Report state changed before the draft could be saved.',
            })
          }

          await transaction.auditLog.create({
            data: {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: 'admin.report.edited',
              targetType: 'WeeklyReport',
              targetId: input.reportId,
              beforeState: { status: existing.status, updatedAt: existing.updatedAt.toISOString() },
              afterState: { status: 'DRAFT', updatedAt: nextUpdatedAt.toISOString() },
            },
          })

          return { ok: true, updatedAt: nextUpdatedAt.toISOString() }
        }),
      )
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
      return withTenantIsolationBypass(() =>
        db.$transaction(async (transaction) => {
          await lockVenueReportMutation(transaction, input)
          const configuration = await findVenueReportConfiguration(
            transaction,
            input.tenantId,
            input.venueId,
          )
          if (configuration?.enabled !== true) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Weekly reports are disabled for this venue.',
            })
          }

          const existing = await transaction.weeklyReport.findFirst({
            where: {
              id: input.reportId,
              tenantId: input.tenantId,
              venueId: input.venueId,
            },
            select: { status: true, content: true, updatedAt: true },
          })
          if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' })
          if (existing.status !== 'DRAFT') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Only a draft report can be published.',
            })
          }
          if (!existing.content) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Report has no content to publish.',
            })
          }

          const expectedUpdatedAt = new Date(input.expectedUpdatedAt)
          if (existing.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'This report changed after review. Reload it before publishing.',
            })
          }
          const publishedAt = new Date()
          const updated = await transaction.weeklyReport.updateMany({
            where: {
              id: input.reportId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              status: 'DRAFT',
              updatedAt: expectedUpdatedAt,
            },
            data: { status: 'PUBLISHED', publishedAt },
          })
          if (updated.count !== 1) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Report state changed before it could be published.',
            })
          }

          await transaction.auditLog.create({
            data: {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: 'admin.report.published',
              targetType: 'WeeklyReport',
              targetId: input.reportId,
              beforeState: { status: existing.status, updatedAt: existing.updatedAt.toISOString() },
              afterState: { status: 'PUBLISHED', publishedAt: publishedAt.toISOString() },
            },
          })

          return { ok: true }
        }),
      )
    }),
})
