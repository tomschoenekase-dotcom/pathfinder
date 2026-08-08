import { randomUUID } from 'node:crypto'

import { db } from '../client'

export type GenerationRequestKind = 'ANSWER_ANALYSIS' | 'WEEKLY_REPORT'

export const GENERATION_DISPATCH_BATCH_SIZE = 50
export const GENERATION_DISPATCH_LEASE_MS = 60_000
export const GENERATION_DISPATCH_DEFER_MS = 5 * 60_000
export const GENERATION_DISPATCH_MAX_ERROR_LENGTH = 1_000

export type LeasedGenerationRequestDispatch = {
  id: string
  tenantId: string
  venueId: string
  kind: GenerationRequestKind
  requestId: string | null
  requestHash: string | null
  recordId: string
  rangeStart: Date
  rangeEnd: Date
  answerAnalysisSnapshotId: string | null
  weeklyReportId: string | null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function boundedLimit(limit = GENERATION_DISPATCH_BATCH_SIZE): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > GENERATION_DISPATCH_BATCH_SIZE) {
    throw new Error(
      `Generation dispatch limit must be an integer from 1 to ${GENERATION_DISPATCH_BATCH_SIZE}.`,
    )
  }
  return limit
}

function validLeaseToken(token: string): void {
  if (!UUID_PATTERN.test(token))
    throw new Error('Generation dispatch lease token must be a valid UUID.')
}

export async function leaseGenerationRequestDispatches(params?: {
  limit?: number
}): Promise<{ leaseToken: string; dispatches: LeasedGenerationRequestDispatch[] }> {
  const leaseToken = randomUUID()
  const limit = boundedLimit(params?.limit)
  const dispatches = await db.$queryRaw<LeasedGenerationRequestDispatch[]>`
    WITH candidates AS (
      SELECT id FROM generation_request_dispatches
      WHERE status = 'PENDING' AND next_attempt_at <= clock_timestamp()
        AND (lease_token IS NULL OR lease_expires_at <= clock_timestamp())
      ORDER BY next_attempt_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT ${limit}
    )
    UPDATE generation_request_dispatches d
    SET lease_token = ${leaseToken}::uuid,
        lease_expires_at = clock_timestamp() + ${GENERATION_DISPATCH_LEASE_MS} * INTERVAL '1 millisecond',
        attempts = d.attempts + 1, updated_at = clock_timestamp()
    FROM candidates WHERE d.id = candidates.id
    RETURNING d.id, d.tenant_id AS "tenantId", d.venue_id AS "venueId", d.kind,
      d.request_id AS "requestId", d.request_hash AS "requestHash", d.record_id AS "recordId",
      d.range_start AS "rangeStart", d.range_end AS "rangeEnd",
      d.answer_analysis_snapshot_id AS "answerAnalysisSnapshotId", d.weekly_report_id AS "weeklyReportId"
  `
  return { leaseToken, dispatches }
}

export type ExactGenerationRequestDispatch = {
  id: string
  tenantId: string
  venueId: string
  kind: GenerationRequestKind
  recordId: string
  leaseToken: string
}

export async function deferGenerationRequestDispatch(
  params: ExactGenerationRequestDispatch,
): Promise<boolean> {
  validLeaseToken(params.leaseToken)
  return (
    (await db.$executeRaw`UPDATE generation_request_dispatches SET lease_token=NULL, lease_expires_at=NULL, last_error=NULL, next_attempt_at=clock_timestamp()+${GENERATION_DISPATCH_DEFER_MS}*INTERVAL '1 millisecond', updated_at=clock_timestamp() WHERE id=${params.id} AND tenant_id=${params.tenantId} AND venue_id=${params.venueId} AND kind=${params.kind}::"GenerationRequestKind" AND record_id=${params.recordId} AND status='PENDING' AND lease_token=${params.leaseToken}::uuid`) ===
    1
  )
}

export async function failGenerationRequestDispatch(
  params: ExactGenerationRequestDispatch & { error: string },
): Promise<boolean> {
  validLeaseToken(params.leaseToken)
  const error = params.error.slice(0, GENERATION_DISPATCH_MAX_ERROR_LENGTH)
  return (
    (await db.$executeRaw`UPDATE generation_request_dispatches SET lease_token=NULL, lease_expires_at=NULL, next_attempt_at=clock_timestamp()+LEAST(300,5*POWER(2,LEAST(GREATEST(attempts-1,0),6)))*INTERVAL '1 second', last_error=${error}, updated_at=clock_timestamp() WHERE id=${params.id} AND tenant_id=${params.tenantId} AND venue_id=${params.venueId} AND kind=${params.kind}::"GenerationRequestKind" AND record_id=${params.recordId} AND status='PENDING' AND lease_token=${params.leaseToken}::uuid`) ===
    1
  )
}

export async function settleGenerationRequestDispatch(
  params: ExactGenerationRequestDispatch,
): Promise<boolean> {
  validLeaseToken(params.leaseToken)
  return (
    (await db.$executeRaw`UPDATE generation_request_dispatches SET status='CONSUMED', consumed_at=clock_timestamp(), lease_token=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=clock_timestamp() WHERE id=${params.id} AND tenant_id=${params.tenantId} AND venue_id=${params.venueId} AND kind=${params.kind}::"GenerationRequestKind" AND record_id=${params.recordId} AND status='PENDING' AND lease_token=${params.leaseToken}::uuid`) ===
    1
  )
}

export async function settleProgressedGenerationRequestDispatch(
  params: ExactGenerationRequestDispatch,
): Promise<boolean> {
  validLeaseToken(params.leaseToken)
  if (params.kind === 'ANSWER_ANALYSIS') {
    return (
      (await db.$executeRaw`
      UPDATE generation_request_dispatches d
      SET status='CONSUMED', consumed_at=clock_timestamp(), lease_token=NULL,
          lease_expires_at=NULL, last_error=NULL, updated_at=clock_timestamp()
      FROM answer_analysis_snapshots s
      WHERE d.id=${params.id} AND d.tenant_id=${params.tenantId}
        AND d.venue_id=${params.venueId} AND d.kind='ANSWER_ANALYSIS'
        AND d.record_id=${params.recordId} AND d.status='PENDING'
        AND d.lease_token=${params.leaseToken}::uuid
        AND d.answer_analysis_snapshot_id=s.id AND s.id=${params.recordId}
        AND s.tenant_id=d.tenant_id AND s.venue_id=d.venue_id
        AND s.range_start=d.range_start AND s.range_end=d.range_end
        AND (s.execution_lease_token IS NOT NULL OR s.status <> 'GENERATING')
    `) === 1
    )
  }
  return (
    (await db.$executeRaw`
    UPDATE generation_request_dispatches d
    SET status='CONSUMED', consumed_at=clock_timestamp(), lease_token=NULL,
        lease_expires_at=NULL, last_error=NULL, updated_at=clock_timestamp()
    FROM weekly_reports r
    WHERE d.id=${params.id} AND d.tenant_id=${params.tenantId}
      AND d.venue_id=${params.venueId} AND d.kind='WEEKLY_REPORT'
      AND d.record_id=${params.recordId} AND d.status='PENDING'
      AND d.lease_token=${params.leaseToken}::uuid
      AND d.weekly_report_id=r.id AND r.id=${params.recordId}
      AND r.tenant_id=d.tenant_id AND r.venue_id=d.venue_id
      AND r.week_start=d.range_start AND r.week_end=d.range_end
      AND (r.execution_lease_token IS NOT NULL OR r.status <> 'GENERATING')
  `) === 1
  )
}

export async function adoptLegacyNullLeaseGenerationDispatches(params?: {
  limitPerType?: number
}): Promise<{ answerAnalysis: number; weeklyReports: number }> {
  const limit = boundedLimit(params?.limitPerType)
  const answerAnalysis =
    await db.$executeRaw`INSERT INTO generation_request_dispatches (id,tenant_id,venue_id,kind,record_id,range_start,range_end,answer_analysis_snapshot_id,created_at,updated_at) SELECT 'legacy-aa-'||md5(s.id),s.tenant_id,s.venue_id,'ANSWER_ANALYSIS',s.id,s.range_start,s.range_end,s.id,clock_timestamp(),clock_timestamp() FROM answer_analysis_snapshots s WHERE s.status='GENERATING' AND s.execution_lease_token IS NULL AND s.execution_lease_expires_at IS NULL AND NOT EXISTS (SELECT 1 FROM generation_request_dispatches d WHERE d.tenant_id=s.tenant_id AND d.kind='ANSWER_ANALYSIS' AND d.record_id=s.id) ORDER BY s.created_at,s.id LIMIT ${limit} ON CONFLICT (tenant_id,kind,record_id) DO NOTHING`
  const weeklyReports =
    await db.$executeRaw`INSERT INTO generation_request_dispatches (id,tenant_id,venue_id,kind,record_id,range_start,range_end,weekly_report_id,created_at,updated_at) SELECT 'legacy-wr-'||md5(r.id),r.tenant_id,r.venue_id,'WEEKLY_REPORT',r.id,r.week_start,r.week_end,r.id,clock_timestamp(),clock_timestamp() FROM weekly_reports r WHERE r.status='GENERATING' AND r.execution_lease_token IS NULL AND r.execution_lease_expires_at IS NULL AND NOT EXISTS (SELECT 1 FROM generation_request_dispatches d WHERE d.tenant_id=r.tenant_id AND d.kind='WEEKLY_REPORT' AND d.record_id=r.id) ORDER BY r.created_at,r.id LIMIT ${limit} ON CONFLICT (tenant_id,kind,record_id) DO NOTHING`
  return { answerAnalysis, weeklyReports }
}
