import { db } from '@pathfinder/db'
import { WEEKLY_REPORT_QUEUE } from '@pathfinder/jobs'

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

export async function readWeeklyReportLifecycle(
  input: Readonly<{ tenantId: string; venueId: string; reportId: string }>,
  database: typeof db = db,
) {
  const [report, configuration, dispatch, jobs, audits] = await Promise.all([
    database.weeklyReport.findFirst({
      where: { id: input.reportId, tenantId: input.tenantId, venueId: input.venueId },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        weekStart: true,
        weekEnd: true,
        title: true,
        status: true,
        updatedAt: true,
        generatedAt: true,
        publishedAt: true,
        answerCount: true,
        sessionCount: true,
        error: true,
        createdAt: true,
      },
    }),
    database.venueReportConfiguration.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId },
      select: { enabled: true, updatedAt: true, updatedBy: true },
    }),
    database.generationRequestDispatch.findFirst({
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
    database.jobRecord.findMany({
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
        createdAt: true,
      },
    }),
    database.auditLog.findMany({
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
  if (!report) return null
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
    report,
    dispatch,
    jobs,
    audits,
  }
}
