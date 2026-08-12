import { randomUUID } from 'node:crypto'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

// The runtime value is Prisma's transaction-scoped extended client. Its generated
// structural type is not assignable to Prisma.TransactionClient under exact optionals.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawExecutor = any

// Generation calls may legitimately take tens of seconds. Five minutes gives a worker
// ample headroom while periodic renewal keeps live work fenced from crash recovery.
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

export type DeferAnswerAnalysisExecutionParams = AcquireAnswerAnalysisExecutionParams & {
  leaseToken: string
}

export type DeferWeeklyReportExecutionParams = AcquireWeeklyReportExecutionParams & {
  leaseToken: string
}

export type RenewAnswerAnalysisExecutionParams = AcquireAnswerAnalysisExecutionParams & {
  leaseToken: string
}

export type RenewWeeklyReportExecutionParams = AcquireWeeklyReportExecutionParams & {
  leaseToken: string
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

async function consumeAnswerAnalysisDispatch(
  tx: RawExecutor,
  params: AcquireAnswerAnalysisExecutionParams,
): Promise<void> {
  const receiptId = randomUUID()
  const consumed = await tx.$executeRaw`
    INSERT INTO generation_request_dispatches
      (id, tenant_id, venue_id, kind, record_id, range_start, range_end,
       status, consumed_at, answer_analysis_snapshot_id, created_at, updated_at)
    VALUES (${receiptId}, ${params.tenantId}, ${params.venueId}, 'ANSWER_ANALYSIS',
      ${params.snapshotId}, ${params.rangeStart}, ${params.rangeEnd}, 'CONSUMED',
      clock_timestamp(), ${params.snapshotId}, clock_timestamp(), clock_timestamp())
    ON CONFLICT (tenant_id, kind, record_id) DO UPDATE SET
      status='CONSUMED', consumed_at=clock_timestamp(), lease_token=NULL,
      lease_expires_at=NULL, last_error=NULL, updated_at=clock_timestamp()
    WHERE generation_request_dispatches.tenant_id=${params.tenantId}
      AND generation_request_dispatches.venue_id=${params.venueId}
      AND generation_request_dispatches.kind='ANSWER_ANALYSIS'
      AND generation_request_dispatches.record_id=${params.snapshotId}
      AND generation_request_dispatches.answer_analysis_snapshot_id=${params.snapshotId}
      AND generation_request_dispatches.weekly_report_id IS NULL
      AND generation_request_dispatches.range_start=${params.rangeStart}
      AND generation_request_dispatches.range_end=${params.rangeEnd}
  `
  if (consumed !== 1)
    throw new Error('Generation dispatch did not match the acquired answer-analysis scope.')
}

async function consumeWeeklyReportDispatch(
  tx: RawExecutor,
  params: AcquireWeeklyReportExecutionParams,
): Promise<void> {
  const receiptId = randomUUID()
  const consumed = await tx.$executeRaw`
    INSERT INTO generation_request_dispatches
      (id, tenant_id, venue_id, kind, record_id, range_start, range_end,
       status, consumed_at, weekly_report_id, created_at, updated_at)
    VALUES (${receiptId}, ${params.tenantId}, ${params.venueId}, 'WEEKLY_REPORT',
      ${params.reportId}, ${params.weekStart}, ${params.weekEnd}, 'CONSUMED',
      clock_timestamp(), ${params.reportId}, clock_timestamp(), clock_timestamp())
    ON CONFLICT (tenant_id, kind, record_id) DO UPDATE SET
      status='CONSUMED', consumed_at=clock_timestamp(), lease_token=NULL,
      lease_expires_at=NULL, last_error=NULL, updated_at=clock_timestamp()
    WHERE generation_request_dispatches.tenant_id=${params.tenantId}
      AND generation_request_dispatches.venue_id=${params.venueId}
      AND generation_request_dispatches.kind='WEEKLY_REPORT'
      AND generation_request_dispatches.record_id=${params.reportId}
      AND generation_request_dispatches.weekly_report_id=${params.reportId}
      AND generation_request_dispatches.answer_analysis_snapshot_id IS NULL
      AND generation_request_dispatches.range_start=${params.weekStart}
      AND generation_request_dispatches.range_end=${params.weekEnd}
  `
  if (consumed !== 1)
    throw new Error('Generation dispatch did not match the acquired weekly-report scope.')
}

export async function acquireAnswerAnalysisExecution(
  params: AcquireAnswerAnalysisExecutionParams,
): Promise<GenerationExecutionAcquisition> {
  const leaseToken = randomUUID()
  return withTenantIsolationBypass(() =>
    db.$transaction(async (tx) => {
      const acquired = await tx.$executeRaw`
      UPDATE answer_analysis_snapshots
      SET
        status = 'GENERATING',
        error = NULL,
        execution_lease_token = ${leaseToken}::uuid,
        execution_lease_expires_at = clock_timestamp() + ${GENERATION_EXECUTION_LEASE_MS} * INTERVAL '1 millisecond',
        recovery_lineage_token = NULL
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
    `
      if (acquired === 1) {
        await consumeAnswerAnalysisDispatch(tx, params)
        return { state: 'acquired', leaseToken }
      }

      const current = await tx.answerAnalysisSnapshot.findFirst({
        where: {
          id: params.snapshotId,
          tenantId: params.tenantId,
          venueId: params.venueId,
          rangeStart: params.rangeStart,
          rangeEnd: params.rangeEnd,
        },
        select: { status: true },
      })
      if (!current) return { state: 'missing' }
      if (current.status === 'GENERATING' || current.status === 'FAILED') return { state: 'leased' }
      await consumeAnswerAnalysisDispatch(tx, params)
      return { state: 'terminal' }
    }),
  )
}

export async function acquireWeeklyReportExecution(
  params: AcquireWeeklyReportExecutionParams,
): Promise<GenerationExecutionAcquisition> {
  const leaseToken = randomUUID()
  return withTenantIsolationBypass(() =>
    db.$transaction(async (tx) => {
      const acquired = await tx.$executeRaw`
      UPDATE weekly_reports
      SET
        status = 'GENERATING',
        error = NULL,
        execution_lease_token = ${leaseToken}::uuid,
        execution_lease_expires_at = clock_timestamp() + ${GENERATION_EXECUTION_LEASE_MS} * INTERVAL '1 millisecond',
        recovery_lineage_token = NULL
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
    `
      if (acquired === 1) {
        await consumeWeeklyReportDispatch(tx, params)
        return { state: 'acquired', leaseToken }
      }

      const current = await tx.weeklyReport.findFirst({
        where: {
          id: params.reportId,
          tenantId: params.tenantId,
          venueId: params.venueId,
          weekStart: params.weekStart,
          weekEnd: params.weekEnd,
        },
        select: { status: true },
      })
      if (!current) return { state: 'missing' }
      if (current.status === 'GENERATING' || current.status === 'FAILED') return { state: 'leased' }
      await consumeWeeklyReportDispatch(tx, params)
      return { state: 'terminal' }
    }),
  )
}

export async function renewAnswerAnalysisExecution(
  params: RenewAnswerAnalysisExecutionParams,
): Promise<boolean> {
  return withTenantIsolationBypass(async () => {
    const updated = await db.$executeRaw`
      UPDATE answer_analysis_snapshots
      SET execution_lease_expires_at = clock_timestamp() + ${GENERATION_EXECUTION_LEASE_MS} * INTERVAL '1 millisecond'
      WHERE id = ${params.snapshotId}
        AND tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND range_start = ${params.rangeStart}
        AND range_end = ${params.rangeEnd}
        AND status = 'GENERATING'
        AND execution_lease_token = ${params.leaseToken}::uuid
        AND execution_lease_expires_at > clock_timestamp()
    `
    return updated === 1
  })
}

export async function renewWeeklyReportExecution(
  params: RenewWeeklyReportExecutionParams,
): Promise<boolean> {
  return withTenantIsolationBypass(async () => {
    const updated = await db.$executeRaw`
      UPDATE weekly_reports
      SET execution_lease_expires_at = clock_timestamp() + ${GENERATION_EXECUTION_LEASE_MS} * INTERVAL '1 millisecond'
      WHERE id = ${params.reportId}
        AND tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND week_start = ${params.weekStart}
        AND week_end = ${params.weekEnd}
        AND status = 'GENERATING'
        AND execution_lease_token = ${params.leaseToken}::uuid
        AND execution_lease_expires_at > clock_timestamp()
    `
    return updated === 1
  })
}

export async function deferAnswerAnalysisExecution(
  params: DeferAnswerAnalysisExecutionParams,
): Promise<boolean> {
  return withTenantIsolationBypass(async () => {
    const updated = await db.$executeRaw`
      UPDATE answer_analysis_snapshots
      SET execution_lease_token = NULL,
          execution_lease_expires_at = NULL
      WHERE id = ${params.snapshotId}
        AND tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND range_start = ${params.rangeStart}
        AND range_end = ${params.rangeEnd}
        AND status = 'GENERATING'
        AND execution_lease_token = ${params.leaseToken}::uuid
    `
    return updated === 1
  })
}

export async function deferWeeklyReportExecution(
  params: DeferWeeklyReportExecutionParams,
): Promise<boolean> {
  return withTenantIsolationBypass(async () => {
    const updated = await db.$executeRaw`
      UPDATE weekly_reports
      SET execution_lease_token = NULL,
          execution_lease_expires_at = NULL
      WHERE id = ${params.reportId}
        AND tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND week_start = ${params.weekStart}
        AND week_end = ${params.weekEnd}
        AND status = 'GENERATING'
        AND execution_lease_token = ${params.leaseToken}::uuid
    `
    return updated === 1
  })
}

export async function acquireAnswerAnalysisRecoveryExecution(
  params: AcquireAnswerAnalysisRecoveryExecutionParams,
): Promise<GenerationRecoveryExecutionAcquisition> {
  validateObservedLeaseToken(params.observedLeaseToken)
  const leaseToken = randomUUID()
  return withTenantIsolationBypass(() =>
    db.$transaction(async (tx) => {
      const acquired = await tx.$executeRaw`
      UPDATE answer_analysis_snapshots
      SET
        status = 'GENERATING',
        error = NULL,
        execution_lease_token = ${leaseToken}::uuid,
        execution_lease_expires_at = clock_timestamp() + ${GENERATION_EXECUTION_LEASE_MS} * INTERVAL '1 millisecond',
        recovery_lineage_token = ${params.observedLeaseToken}::uuid
      WHERE id = ${params.snapshotId}
        AND tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND range_start = ${params.rangeStart}
        AND range_end = ${params.rangeEnd}
        AND ((status = 'GENERATING'
          AND execution_lease_token = ${params.observedLeaseToken}::uuid
          AND execution_lease_expires_at IS NOT NULL
          AND execution_lease_expires_at <= clock_timestamp())
          OR (status = 'GENERATING'
            AND execution_lease_token IS NULL
            AND execution_lease_expires_at IS NULL
            AND recovery_lineage_token = ${params.observedLeaseToken}::uuid)
          OR (status = 'FAILED'
            AND execution_lease_token IS NULL
            AND execution_lease_expires_at IS NULL
            AND recovery_lineage_token = ${params.observedLeaseToken}::uuid))
    `
      if (acquired === 1) {
        await consumeAnswerAnalysisDispatch(tx, params)
        return { state: 'acquired', leaseToken }
      }

      const current = await tx.answerAnalysisSnapshot.findFirst({
        where: {
          id: params.snapshotId,
          tenantId: params.tenantId,
          venueId: params.venueId,
          rangeStart: params.rangeStart,
          rangeEnd: params.rangeEnd,
        },
        select: { status: true },
      })
      if (!current) return { state: 'missing' }
      if (current.status !== 'COMPLETE') return { state: 'ineligible' }
      await consumeAnswerAnalysisDispatch(tx, params)
      return { state: 'terminal' }
    }),
  )
}

export async function acquireWeeklyReportRecoveryExecution(
  params: AcquireWeeklyReportRecoveryExecutionParams,
): Promise<GenerationRecoveryExecutionAcquisition> {
  validateObservedLeaseToken(params.observedLeaseToken)
  const leaseToken = randomUUID()
  return withTenantIsolationBypass(() =>
    db.$transaction(async (tx) => {
      const acquired = await tx.$executeRaw`
      UPDATE weekly_reports
      SET
        status = 'GENERATING',
        error = NULL,
        execution_lease_token = ${leaseToken}::uuid,
        execution_lease_expires_at = clock_timestamp() + ${GENERATION_EXECUTION_LEASE_MS} * INTERVAL '1 millisecond',
        recovery_lineage_token = ${params.observedLeaseToken}::uuid
      WHERE id = ${params.reportId}
        AND tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND week_start = ${params.weekStart}
        AND week_end = ${params.weekEnd}
        AND ((status = 'GENERATING'
          AND execution_lease_token = ${params.observedLeaseToken}::uuid
          AND execution_lease_expires_at IS NOT NULL
          AND execution_lease_expires_at <= clock_timestamp())
          OR (status = 'GENERATING'
            AND execution_lease_token IS NULL
            AND execution_lease_expires_at IS NULL
            AND recovery_lineage_token = ${params.observedLeaseToken}::uuid)
          OR (status = 'FAILED'
            AND execution_lease_token IS NULL
            AND execution_lease_expires_at IS NULL
            AND recovery_lineage_token = ${params.observedLeaseToken}::uuid))
    `
      if (acquired === 1) {
        await consumeWeeklyReportDispatch(tx, params)
        return { state: 'acquired', leaseToken }
      }

      const current = await tx.weeklyReport.findFirst({
        where: {
          id: params.reportId,
          tenantId: params.tenantId,
          venueId: params.venueId,
          weekStart: params.weekStart,
          weekEnd: params.weekEnd,
        },
        select: { status: true },
      })
      if (!current) return { state: 'missing' }
      if (current.status !== 'DRAFT' && current.status !== 'PUBLISHED')
        return { state: 'ineligible' }
      await consumeWeeklyReportDispatch(tx, params)
      return { state: 'terminal' }
    }),
  )
}
