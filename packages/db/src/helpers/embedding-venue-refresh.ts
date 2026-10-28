import { createHash } from 'node:crypto'

import type { Prisma } from '@prisma/client'

import { db } from '../client'
import {
  auditEmbeddingFreshness,
  type EmbeddingAuditClient,
  type EmbeddingFreshnessAudit,
} from './embedding-freshness'

export const VENUE_EMBEDDING_REFRESH_MAX_RECORDS = 1000
export type VenueEmbeddingRefreshScope = { tenantId: string; venueId: string }
export type VenueEmbeddingRefreshIdentity = VenueEmbeddingRefreshScope & { refreshId: string }
export type VenueEmbeddingRefreshAuditSummary = {
  scanned: number
  truncated: boolean
  groups: EmbeddingFreshnessAudit['groups']
  candidateCount: number
  blockedCount: number
}
export type VenueEmbeddingRefreshErrorCode =
  | 'INVALID_MAX'
  | 'NOT_FOUND'
  | 'INELIGIBLE'
  | 'AUDIT_BLOCKED'
  | 'PLAN_CHANGED'
  | 'MAX_EXCEEDED'
  | 'OPERATION_MISMATCH'
  | 'ACTIVE_REFRESH'
  | 'INVALID_OUTCOME'
  | 'DISPATCHER_ENABLED'
export class VenueEmbeddingRefreshError extends Error {
  constructor(public readonly code: VenueEmbeddingRefreshErrorCode) {
    super(code)
    this.name = 'VenueEmbeddingRefreshError'
  }
}
const blockingReasons = new Set([
  'current-running',
  'dispatch-leased',
  'complete-claim-missing-vector-invariant-breach',
])
export function summarizeVenueEmbeddingRefreshAudit(
  audit: EmbeddingFreshnessAudit,
): VenueEmbeddingRefreshAuditSummary {
  return {
    scanned: audit.scanned,
    truncated: audit.truncated,
    groups: audit.groups,
    candidateCount: audit.actionableCandidates.length,
    blockedCount: audit.groups
      .filter((group) => blockingReasons.has(group.reason))
      .reduce((sum, group) => sum + group.count, 0),
  }
}

/** Read-only: no durable rows, queues or model calls. Manifest contains hashes, never content. */
export async function planVenueEmbeddingRefresh(
  scope: VenueEmbeddingRefreshScope,
  database: typeof db | EmbeddingAuditClient = db,
) {
  const venue = await database.venue.findFirst({
    where: { id: scope.venueId, tenantId: scope.tenantId },
    select: { isActive: true },
  })
  if (!venue) throw new VenueEmbeddingRefreshError('NOT_FOUND')
  const audit = await auditEmbeddingFreshness({ ...scope, manualRefresh: true }, database)
  const beforeAudit = summarizeVenueEmbeddingRefreshAudit(audit)
  const manifest = audit.actionableCandidates
    .map(
      ({
        entityType,
        entityId,
        contentUpdatedAt,
        sourceHash,
        embeddingProfile,
        primaryReason,
      }) => ({
        entityType,
        entityId,
        contentUpdatedAt,
        sourceHash,
        embeddingProfile,
        primaryReason,
      }),
    )
    .sort((a, b) => `${a.entityType}:${a.entityId}`.localeCompare(`${b.entityType}:${b.entityId}`))
  const planDigest = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        eligible:
          venue.isActive &&
          !beforeAudit.truncated &&
          beforeAudit.blockedCount === 0 &&
          manifest.length <= VENUE_EMBEDDING_REFRESH_MAX_RECORDS,
        beforeAudit,
        manifest,
      }),
    )
    .digest('hex')
  return {
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    planDigest,
    candidateCount: manifest.length,
    maxRecords: VENUE_EMBEDDING_REFRESH_MAX_RECORDS,
    blockedCount: beforeAudit.blockedCount,
    truncated: audit.truncated,
    eligible:
      venue.isActive &&
      !beforeAudit.truncated &&
      beforeAudit.blockedCount === 0 &&
      manifest.length <= VENUE_EMBEDDING_REFRESH_MAX_RECORDS,
    beforeAudit,
    manifest,
  }
}
export type VenueEmbeddingRefreshPlan = Awaited<ReturnType<typeof planVenueEmbeddingRefresh>>
const includeRecords = {
  records: { orderBy: { ordinal: 'asc' as const }, take: VENUE_EMBEDDING_REFRESH_MAX_RECORDS },
}
type StoredRefresh = Prisma.EmbeddingVenueRefreshGetPayload<{ include: typeof includeRecords }>
function parseAudit(value: Prisma.JsonValue | null): VenueEmbeddingRefreshAuditSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (
    typeof value.scanned !== 'number' ||
    typeof value.truncated !== 'boolean' ||
    typeof value.candidateCount !== 'number' ||
    typeof value.blockedCount !== 'number' ||
    !Array.isArray(value.groups)
  )
    return null
  if (
    ![value.scanned, value.candidateCount, value.blockedCount].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    return null
  return {
    scanned: value.scanned,
    truncated: value.truncated,
    candidateCount: value.candidateCount,
    blockedCount: value.blockedCount,
    groups: value.groups as VenueEmbeddingRefreshAuditSummary['groups'],
  }
}
function receipt(run: StoredRefresh) {
  const counts = { completed: 0, failed: 0, unknown: 0, running: 0, unattempted: 0 }
  for (const record of run.records) {
    if (record.status === 'COMPLETE') counts.completed++
    else if (record.status === 'FAILED') counts.failed++
    else if (record.status === 'OUTCOME_UNKNOWN') counts.unknown++
    else if (record.status === 'RUNNING') counts.running++
    else counts.unattempted++
  }
  const beforeAudit = parseAudit(run.beforeAudit)
  const afterAudit = parseAudit(run.afterAudit)
  return {
    ...run,
    beforeAudit,
    afterAudit,
    freshnessProven:
      run.status === 'COMPLETE' &&
      afterAudit !== null &&
      !afterAudit.truncated &&
      afterAudit.candidateCount === 0 &&
      afterAudit.blockedCount === 0,
    counts,
  }
}
export type VenueEmbeddingRefreshReceipt = ReturnType<typeof receipt>
export async function getVenueEmbeddingRefresh(
  scope: VenueEmbeddingRefreshIdentity,
  database: typeof db | EmbeddingAuditClient = db,
): Promise<VenueEmbeddingRefreshReceipt | null> {
  const run = await database.embeddingVenueRefresh.findFirst({
    where: { id: scope.refreshId, tenantId: scope.tenantId, venueId: scope.venueId },
    include: includeRecords,
  })
  return run ? receipt(run) : null
}
export async function findVenueEmbeddingRefreshByOperation(
  scope: VenueEmbeddingRefreshScope & { operationKey: string },
  database: typeof db | EmbeddingAuditClient = db,
): Promise<VenueEmbeddingRefreshReceipt | null> {
  const run = await database.embeddingVenueRefresh.findFirst({
    where: { tenantId: scope.tenantId, venueId: scope.venueId, operationKey: scope.operationKey },
    include: includeRecords,
  })
  return run ? receipt(run) : null
}
type Request = VenueEmbeddingRefreshScope & {
  operationKey: string
  planDigest: string
  max: number
  requestedBy: string
}
function replay(run: VenueEmbeddingRefreshReceipt, input: Request) {
  if (
    run.planDigest !== input.planDigest ||
    run.maxRecords !== input.max ||
    run.requestedBy !== input.requestedBy
  )
    throw new VenueEmbeddingRefreshError('OPERATION_MISMATCH')
  return run
}
export async function requestVenueEmbeddingRefresh(
  input: Request,
  database: typeof db = db,
): Promise<VenueEmbeddingRefreshReceipt> {
  if (
    !Number.isInteger(input.max) ||
    input.max < 0 ||
    input.max > VENUE_EMBEDDING_REFRESH_MAX_RECORDS
  )
    throw new VenueEmbeddingRefreshError('INVALID_MAX')
  const existing = await findVenueEmbeddingRefreshByOperation(input, database)
  if (existing) return replay(existing, input)
  if (process.env.EMBEDDING_DISPATCH_ENABLED !== 'false')
    throw new VenueEmbeddingRefreshError('DISPATCHER_ENABLED')
  try {
    return await database.$transaction(
      async (tx) => {
        const plan = await planVenueEmbeddingRefresh(input, tx)
        if (plan.truncated || plan.blockedCount)
          throw new VenueEmbeddingRefreshError('AUDIT_BLOCKED')
        if (plan.planDigest !== input.planDigest)
          throw new VenueEmbeddingRefreshError('PLAN_CHANGED')
        if (plan.candidateCount > input.max) throw new VenueEmbeddingRefreshError('MAX_EXCEEDED')
        if (!plan.eligible) throw new VenueEmbeddingRefreshError('INELIGIBLE')
        const run = await tx.embeddingVenueRefresh.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            operationKey: input.operationKey,
            planDigest: input.planDigest,
            maxRecords: input.max,
            requestedBy: input.requestedBy,
            beforeAudit: plan.beforeAudit,
            ...(plan.candidateCount === 0
              ? { status: 'COMPLETE', completedAt: new Date(), afterAudit: plan.beforeAudit }
              : {}),
          },
        })
        if (plan.manifest.length)
          await tx.embeddingVenueRefreshRecord.createMany({
            data: plan.manifest.map((record, ordinal) => ({
              ...record,
              ordinal,
              refreshId: run.id,
              tenantId: input.tenantId,
              venueId: input.venueId,
            })),
          })
        return (await getVenueEmbeddingRefresh({ ...input, refreshId: run.id }, tx))!
      },
      { isolationLevel: 'RepeatableRead', timeout: 30_000 },
    )
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      const concurrent = await findVenueEmbeddingRefreshByOperation(input, database)
      if (concurrent) return replay(concurrent, input)
      throw new VenueEmbeddingRefreshError('ACTIVE_REFRESH')
    }
    throw error
  }
}
function where(scope: VenueEmbeddingRefreshIdentity) {
  return { id: scope.refreshId, tenantId: scope.tenantId, venueId: scope.venueId }
}
export async function claimVenueEmbeddingRefresh(
  scope: VenueEmbeddingRefreshIdentity,
  database: typeof db = db,
) {
  const changed = await database.embeddingVenueRefresh.updateMany({
    where: { ...where(scope), status: 'QUEUED' },
    data: { status: 'RUNNING', startedAt: new Date() },
  })
  return { acquired: changed.count === 1, refresh: await getVenueEmbeddingRefresh(scope, database) }
}
export async function startVenueEmbeddingRefreshRecord(
  scope: VenueEmbeddingRefreshIdentity & { recordId: string },
  database: typeof db = db,
) {
  return database.$transaction(async (tx) => {
    // Serialize all receipt transitions with run termination; never take over a run.
    const active = await tx.embeddingVenueRefresh.updateMany({
      where: { ...where(scope), status: 'RUNNING' },
      data: { status: 'RUNNING' },
    })
    const changed = active.count
      ? await tx.embeddingVenueRefreshRecord.updateMany({
          where: {
            id: scope.recordId,
            refreshId: scope.refreshId,
            tenantId: scope.tenantId,
            venueId: scope.venueId,
            status: 'PENDING',
          },
          data: { status: 'RUNNING', startedAt: new Date() },
        })
      : { count: 0 }
    return { acquired: changed.count === 1, refresh: await getVenueEmbeddingRefresh(scope, tx) }
  })
}
export type VenueEmbeddingRefreshRecordOutcome = {
  status: 'COMPLETE' | 'FAILED' | 'OUTCOME_UNKNOWN'
  code?: string
}
function sanitizedCode(code?: string) {
  return code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'REFRESH_STOPPED'
}
export async function finishVenueEmbeddingRefreshRecord(
  scope: VenueEmbeddingRefreshIdentity & {
    recordId: string
    outcome: VenueEmbeddingRefreshRecordOutcome
  },
  database: typeof db = db,
) {
  if (!['COMPLETE', 'FAILED', 'OUTCOME_UNKNOWN'].includes(scope.outcome.status))
    throw new VenueEmbeddingRefreshError('INVALID_OUTCOME')
  return database.$transaction(async (tx) => {
    const active = await tx.embeddingVenueRefresh.updateMany({
      where: { ...where(scope), status: 'RUNNING' },
      data: { status: 'RUNNING' },
    })
    const changed = active.count
      ? await tx.embeddingVenueRefreshRecord.updateMany({
          where: {
            id: scope.recordId,
            refreshId: scope.refreshId,
            tenantId: scope.tenantId,
            venueId: scope.venueId,
            status: 'RUNNING',
          },
          data: {
            status: scope.outcome.status,
            outcome: scope.outcome.status === 'COMPLETE' ? null : sanitizedCode(scope.outcome.code),
            completedAt: new Date(),
          },
        })
      : { count: 0 }
    return { acquired: changed.count === 1, refresh: await getVenueEmbeddingRefresh(scope, tx) }
  })
}
export async function stopVenueEmbeddingRefresh(
  scope: VenueEmbeddingRefreshIdentity & { code: string; unknown?: boolean },
  database: typeof db = db,
) {
  return database.$transaction(async (tx) => {
    const active = await tx.embeddingVenueRefresh.updateMany({
      where: { ...where(scope), status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'RUNNING' },
    })
    if (!active.count)
      return { acquired: false, refresh: await getVenueEmbeddingRefresh(scope, tx) }
    const uncertain = await tx.embeddingVenueRefreshRecord.count({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        refreshId: scope.refreshId,
        status: { in: ['RUNNING', 'OUTCOME_UNKNOWN'] },
      },
    })
    await tx.embeddingVenueRefresh.updateMany({
      where: { ...where(scope), status: 'RUNNING' },
      data: {
        status: scope.unknown || uncertain ? 'OUTCOME_UNKNOWN' : 'STOPPED',
        stopCode: sanitizedCode(scope.code),
        completedAt: new Date(),
      },
    })
    return { acquired: true, refresh: await getVenueEmbeddingRefresh(scope, tx) }
  })
}
export async function completeVenueEmbeddingRefresh(
  scope: VenueEmbeddingRefreshIdentity & { afterAudit: VenueEmbeddingRefreshAuditSummary },
  database: typeof db = db,
) {
  return database.$transaction(async (tx) => {
    const active = await tx.embeddingVenueRefresh.updateMany({
      where: { ...where(scope), status: 'RUNNING' },
      data: { status: 'RUNNING' },
    })
    if (!active.count)
      return { acquired: false, refresh: await getVenueEmbeddingRefresh(scope, tx) }
    const remaining = await tx.embeddingVenueRefreshRecord.count({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        refreshId: scope.refreshId,
        status: { not: 'COMPLETE' },
      },
    })
    const uncertain = await tx.embeddingVenueRefreshRecord.count({
      where: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        refreshId: scope.refreshId,
        status: { in: ['RUNNING', 'OUTCOME_UNKNOWN'] },
      },
    })
    const proven =
      !remaining &&
      !scope.afterAudit.truncated &&
      scope.afterAudit.candidateCount === 0 &&
      scope.afterAudit.blockedCount === 0
    await tx.embeddingVenueRefresh.updateMany({
      where: { ...where(scope), status: 'RUNNING' },
      data: {
        status: proven ? 'COMPLETE' : uncertain ? 'OUTCOME_UNKNOWN' : 'STOPPED',
        afterAudit: scope.afterAudit,
        stopCode: proven ? null : 'FINAL_AUDIT_INCOMPLETE',
        completedAt: new Date(),
      },
    })
    return { acquired: true, refresh: await getVenueEmbeddingRefresh(scope, tx) }
  })
}
