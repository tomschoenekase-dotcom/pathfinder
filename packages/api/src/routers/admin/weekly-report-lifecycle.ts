import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { WEEKLY_REPORT_QUEUE } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export type SimpleWeeklyReportStatus = 'QUEUED' | 'RUNNING' | 'REVIEW' | 'PUBLISHED' | 'FAILED'

export function simpleWeeklyReportStatus(input: {
  reportStatus: 'GENERATING' | 'DRAFT' | 'PUBLISHED' | 'FAILED'
  dispatchStatus: 'PENDING' | 'CONSUMED' | null
  jobStatus: 'RUNNING' | 'COMPLETE' | 'FAILED' | null
}): SimpleWeeklyReportStatus {
  if (input.reportStatus === 'DRAFT') return 'REVIEW'
  if (input.reportStatus === 'PUBLISHED') return 'PUBLISHED'
  if (input.reportStatus === 'FAILED') return 'FAILED'
  if (input.dispatchStatus === 'PENDING') return 'QUEUED'
  return 'RUNNING'
}

export const adminWeeklyReportLifecycleRouter = router({
  getWeeklyReportLifecycle: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          reportId: z.string().min(1),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const [report, configuration, dispatch, jobs, audits] = await Promise.all([
          db.weeklyReport.findFirst({
            where: { id: input.reportId, tenantId: input.tenantId, venueId: input.venueId },
            select: {
              id: true,
              tenantId: true,
              venueId: true,
              status: true,
              updatedAt: true,
              generatedAt: true,
              publishedAt: true,
              answerCount: true,
              sessionCount: true,
              error: true,
            },
          }),
          db.venueReportConfiguration.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            select: { enabled: true, updatedAt: true, updatedBy: true },
          }),
          db.generationRequestDispatch.findFirst({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              weeklyReportId: input.reportId,
              kind: 'WEEKLY_REPORT',
            },
            select: {
              id: true,
              requestId: true,
              status: true,
              attempts: true,
              nextAttemptAt: true,
              lastError: true,
              consumedAt: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
          db.jobRecord.findMany({
            where: {
              tenantId: input.tenantId,
              queue: WEEKLY_REPORT_QUEUE,
              payload: { path: ['reportId'], equals: input.reportId },
            },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
              id: true,
              jobName: true,
              status: true,
              error: true,
              attemptNumber: true,
              maxAttempts: true,
              failureDisposition: true,
              startedAt: true,
              completedAt: true,
              terminalAt: true,
            },
          }),
          db.auditLog.findMany({
            where: {
              tenantId: input.tenantId,
              targetType: 'WeeklyReport',
              targetId: input.reportId,
            },
            orderBy: { createdAt: 'desc' },
            take: 25,
            select: { id: true, actorId: true, actorRole: true, action: true, createdAt: true },
          }),
        ])
        if (!report) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' })
        const latestJob = jobs[0] ?? null
        return {
          scope: { tenantId: report.tenantId, venueId: report.venueId, reportId: report.id },
          version: report.updatedAt.toISOString(),
          status: simpleWeeklyReportStatus({
            reportStatus: report.status,
            dispatchStatus: dispatch?.status ?? null,
            jobStatus: latestJob?.status ?? null,
          }),
          legacyStatus: report.status,
          executionEnabled: configuration?.enabled ?? false,
          configuration: configuration
            ? { updatedAt: configuration.updatedAt, updatedBy: configuration.updatedBy }
            : null,
          report: {
            generatedAt: report.generatedAt,
            publishedAt: report.publishedAt,
            answerCount: report.answerCount,
            sessionCount: report.sessionCount,
            error: report.error,
          },
          dispatch,
          jobs,
          audits,
        }
      }),
    ),
})
