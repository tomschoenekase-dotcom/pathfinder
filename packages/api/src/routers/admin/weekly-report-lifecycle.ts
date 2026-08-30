import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { readWeeklyReportLifecycle } from '../../lib/weekly-report-lifecycle'
import { adminProcedure } from '../../trpc'

export { simpleWeeklyReportStatus } from '../../lib/weekly-report-lifecycle'
export type { SimpleWeeklyReportStatus } from '../../lib/weekly-report-lifecycle'

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
        const lifecycle = await readWeeklyReportLifecycle(input, db)
        if (!lifecycle) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' })
        return {
          scope: lifecycle.scope,
          version: lifecycle.version,
          status: lifecycle.status,
          legacyStatus: lifecycle.legacyStatus,
          executionEnabled: lifecycle.executionEnabled,
          configuration: lifecycle.configuration,
          report: {
            generatedAt: lifecycle.report.generatedAt,
            publishedAt: lifecycle.report.publishedAt,
            answerCount: lifecycle.report.answerCount,
            sessionCount: lifecycle.report.sessionCount,
            error: lifecycle.report.error,
          },
          dispatch: lifecycle.dispatch,
          jobs: lifecycle.jobs.map((job) => ({
            id: job.id,
            jobName: job.jobName,
            status: job.status,
            error: job.error,
            attemptNumber: job.attemptNumber,
            maxAttempts: job.maxAttempts,
            failureDisposition: job.failureDisposition,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            terminalAt: job.terminalAt,
          })),
          audits: lifecycle.audits,
        }
      }),
    ),
})
