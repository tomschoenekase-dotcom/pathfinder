import { randomUUID } from 'node:crypto'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

// Generation calls may legitimately take tens of seconds. Five minutes gives a worker
// ample headroom while keeping crash recovery bounded without requiring lease renewal.
export const GENERATION_EXECUTION_LEASE_MS = 5 * 60 * 1_000

export type GenerationExecutionAcquisition =
  | { state: 'acquired'; leaseToken: string }
  | { state: 'leased' | 'terminal' | 'missing' }

export type AcquireAnswerAnalysisExecutionParams = {
  snapshotId: string
  tenantId: string
  venueId: string
  rangeStart: Date
  rangeEnd: Date
}

export type AcquireWeeklyReportExecutionParams = {
  reportId: string
  tenantId: string
  venueId: string
  weekStart: Date
  weekEnd: Date
}

export type AcquireAnswerAnalysisRecoveryExecutionParams = AcquireAnswerAnalysisExecutionParams & {
  observedLeaseToken: string
}

export type AcquireWeeklyReportRecoveryExecutionParams = AcquireWeeklyReportExecutionParams & {
  observedLeaseToken: string
}

export type GenerationRecoveryExecutionAcquisition =
  | { state: 'acquired'; leaseToken: string }
  | { state: 'ineligible' | 'terminal' | 'missing' }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validateObservedLeaseToken(observedLeaseToken: string): void {
  if (!UUID_PATTERN.test(observedLeaseToken)) {
    throw new Error('Observed generation execution lease token must be a valid UUID.')
  }
}

export async function acquireAnswerAnalysisExecution(
  params: AcquireAnswerAnalysisExecutionParams,
): Promise<GenerationExecutionAcquisition> {
  const leaseToken = randomUUID()
  const acquired = await withTenantIsolationBypass(
    () =>
      db.$executeRaw`
      UPDATE answer_analysis_snapshots
      SET
        status = 'GENERATING',
        error = NULL,
        execution_lease_token = ${leaseToken}::uuid,
        execution_lease_expires_at = clock_timestamp() + ${GENERATION_EXECUTION_LEASE_MS} * INTERVAL '1 millisecond'
      WHERE id = ${params.snapshotId}
        AND tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND range_start = ${params.rangeStart}
        AND range_end = ${params.rangeEnd}
        AND status IN ('GENERATING', 'FAILED')
        AND (
          execution_lease_token IS NULL
          OR execution_lease_expires_at <= clock_timestamp()
        )
    `,
  )
  if (acquired === 1) return { state: 'acquired', leaseToken }

  const current = await withTenantIsolationBypass(() =>
    db.answerAnalysisSnapshot.findFirst({
      where: {
        id: params.snapshotId,
        tenantId: params.tenantId,
        venueId: params.venueId,
        rangeStart: params.rangeStart,
        rangeEnd: params.rangeEnd,
      },
      select: { status: true },
    }),
  )
  if (!current) return { state: 'missing' }
  return current.status === 'GENERATING' || current.status === 'FAILED'
    ? { state: 'leased' }
    : { state: 'terminal' }
}

export async function acquireWeeklyReportExecution(
  params: AcquireWeeklyReportExecutionParams,
): Promise<GenerationExecutionAcquisition> {
  const leaseToken = randomUUID()
  const acquired = await withTenantIsolationBypass(
    () =>
      db.$executeRaw`
      UPDATE weekly_reports
      SET
        status = 'GENERATING',
        error = NULL,
        execution_lease_token = ${leaseToken}::uuid,
        execution_lease_expires_at = clock_timestamp() + ${GENERATION_EXECUTION_LEASE_MS} * INTERVAL '1 millisecond'
      WHERE id = ${params.reportId}
        AND tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND week_start = ${params.weekStart}
        AND week_end = ${params.weekEnd}
        AND status IN ('GENERATING', 'FAILED')
        AND (
          execution_lease_token IS NULL
          OR execution_lease_expires_at <= clock_timestamp()
        )
    `,
  )
  if (acquired === 1) return { state: 'acquired', leaseToken }

  const current = await withTenantIsolationBypass(() =>
    db.weeklyReport.findFirst({
      where: {
        id: params.reportId,
        tenantId: params.tenantId,
        venueId: params.venueId,
        weekStart: params.weekStart,
        weekEnd: params.weekEnd,
      },
      select: { status: true },
    }),
  )
  if (!current) return { state: 'missing' }
  return current.status === 'GENERATING' || current.status === 'FAILED'
    ? { state: 'leased' }
    : { state: 'terminal' }
}

export async function acquireAnswerAnalysisRecoveryExecution(
  params: AcquireAnswerAnalysisRecoveryExecutionParams,
): Promise<GenerationRecoveryExecutionAcquisition> {
  validateObservedLeaseToken(params.observedLeaseToken)
  const leaseToken = randomUUID()
  const acquired = await withTenantIsolationBypass(
    () =>
      db.$executeRaw`
      UPDATE answer_analysis_snapshots
      SET
        execution_lease_token = ${leaseToken}::uuid,
        execution_lease_expires_at = clock_timestamp() + ${GENERATION_EXECUTION_LEASE_MS} * INTERVAL '1 millisecond'
      WHERE id = ${params.snapshotId}
        AND tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND range_start = ${params.rangeStart}
        AND range_end = ${params.rangeEnd}
        AND status = 'GENERATING'
        AND execution_lease_token = ${params.observedLeaseToken}::uuid
        AND execution_lease_expires_at IS NOT NULL
        AND execution_lease_expires_at <= clock_timestamp()
    `,
  )
  if (acquired === 1) return { state: 'acquired', leaseToken }

  const current = await withTenantIsolationBypass(() =>
    db.answerAnalysisSnapshot.findFirst({
      where: {
        id: params.snapshotId,
        tenantId: params.tenantId,
        venueId: params.venueId,
        rangeStart: params.rangeStart,
        rangeEnd: params.rangeEnd,
      },
      select: { status: true },
    }),
  )
  if (!current) return { state: 'missing' }
  return current.status === 'COMPLETE' ? { state: 'terminal' } : { state: 'ineligible' }
}

export async function acquireWeeklyReportRecoveryExecution(
  params: AcquireWeeklyReportRecoveryExecutionParams,
): Promise<GenerationRecoveryExecutionAcquisition> {
  validateObservedLeaseToken(params.observedLeaseToken)
  const leaseToken = randomUUID()
  const acquired = await withTenantIsolationBypass(
    () =>
      db.$executeRaw`
      UPDATE weekly_reports
      SET
        execution_lease_token = ${leaseToken}::uuid,
        execution_lease_expires_at = clock_timestamp() + ${GENERATION_EXECUTION_LEASE_MS} * INTERVAL '1 millisecond'
      WHERE id = ${params.reportId}
        AND tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND week_start = ${params.weekStart}
        AND week_end = ${params.weekEnd}
        AND status = 'GENERATING'
        AND execution_lease_token = ${params.observedLeaseToken}::uuid
        AND execution_lease_expires_at IS NOT NULL
        AND execution_lease_expires_at <= clock_timestamp()
    `,
  )
  if (acquired === 1) return { state: 'acquired', leaseToken }

  const current = await withTenantIsolationBypass(() =>
    db.weeklyReport.findFirst({
      where: {
        id: params.reportId,
        tenantId: params.tenantId,
        venueId: params.venueId,
        weekStart: params.weekStart,
        weekEnd: params.weekEnd,
      },
      select: { status: true },
    }),
  )
  if (!current) return { state: 'missing' }
  return current.status === 'DRAFT' || current.status === 'PUBLISHED'
    ? { state: 'terminal' }
    : { state: 'ineligible' }
}
