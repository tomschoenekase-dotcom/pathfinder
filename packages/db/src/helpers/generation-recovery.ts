import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

export const GENERATION_RECOVERY_MAX_PER_TYPE = 50

export type ExpiredAnswerAnalysisExecution = {
  snapshotId: string
  tenantId: string
  venueId: string
  rangeStart: Date
  rangeEnd: Date
  executionLeaseToken: string
}

export type ExpiredWeeklyReportExecution = {
  reportId: string
  tenantId: string
  venueId: string
  weekStart: Date
  weekEnd: Date
  executionLeaseToken: string
}

export type ExpiredGenerationExecutions = {
  answerAnalyses: ExpiredAnswerAnalysisExecution[]
  weeklyReports: ExpiredWeeklyReportExecution[]
}

export async function discoverExpiredGenerationExecutions(
  options: { limitPerType?: number } = {},
): Promise<ExpiredGenerationExecutions> {
  const limitPerType = options.limitPerType ?? GENERATION_RECOVERY_MAX_PER_TYPE
  if (
    !Number.isInteger(limitPerType) ||
    limitPerType < 1 ||
    limitPerType > GENERATION_RECOVERY_MAX_PER_TYPE
  ) {
    throw new Error(
      `Generation recovery limit must be an integer between 1 and ${GENERATION_RECOVERY_MAX_PER_TYPE}.`,
    )
  }

  return withTenantIsolationBypass(async () => {
    const [answerAnalyses, weeklyReports] = await Promise.all([
      db.$queryRaw<ExpiredAnswerAnalysisExecution[]>`
        SELECT
          id AS "snapshotId",
          tenant_id AS "tenantId",
          venue_id AS "venueId",
          range_start AS "rangeStart",
          range_end AS "rangeEnd",
          execution_lease_token::text AS "executionLeaseToken"
        FROM answer_analysis_snapshots
        WHERE status = 'GENERATING'
          AND execution_lease_token IS NOT NULL
          AND execution_lease_expires_at IS NOT NULL
          AND execution_lease_expires_at <= clock_timestamp()
        ORDER BY execution_lease_expires_at ASC, id ASC
        LIMIT ${limitPerType}
      `,
      db.$queryRaw<ExpiredWeeklyReportExecution[]>`
        SELECT
          id AS "reportId",
          tenant_id AS "tenantId",
          venue_id AS "venueId",
          week_start AS "weekStart",
          week_end AS "weekEnd",
          execution_lease_token::text AS "executionLeaseToken"
        FROM weekly_reports
        WHERE status = 'GENERATING'
          AND execution_lease_token IS NOT NULL
          AND execution_lease_expires_at IS NOT NULL
          AND execution_lease_expires_at <= clock_timestamp()
        ORDER BY execution_lease_expires_at ASC, id ASC
        LIMIT ${limitPerType}
      `,
    ])

    return { answerAnalyses, weeklyReports }
  })
}
