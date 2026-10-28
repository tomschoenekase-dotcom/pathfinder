import { env } from '@pathfinder/config'
import {
  assertVenueAiAvailable,
  auditEmbeddingFreshness,
  claimVenueEmbeddingRefresh,
  completeVenueEmbeddingRefresh,
  db,
  finishVenueEmbeddingRefreshRecord,
  getVenueEmbeddingRefresh,
  planVenueEmbeddingRefresh,
  startVenueEmbeddingRefreshRecord,
  stopVenueEmbeddingRefresh,
  type EmbeddingFreshnessCandidate,
} from '@pathfinder/db'
import type { VenueEmbeddingRefreshJobPayload } from '@pathfinder/jobs'
import { UnrecoverableError } from 'bullmq'

import { processEmbedKnowledgeEntryJob } from './embed-knowledge-entry'
import { processEmbedPlaceJob } from './embed-place'

type SealedIdentity = Pick<
  EmbeddingFreshnessCandidate,
  'entityId' | 'contentUpdatedAt' | 'sourceHash' | 'embeddingProfile'
> & { entityType: string }

function sameIdentity(current: SealedIdentity | undefined, sealed: SealedIdentity) {
  return (
    current &&
    current.entityType === sealed.entityType &&
    current.entityId === sealed.entityId &&
    current.contentUpdatedAt.getTime() === new Date(sealed.contentUpdatedAt).getTime() &&
    current.sourceHash === sealed.sourceHash &&
    current.embeddingProfile === sealed.embeddingProfile
  )
}

/** One serial, non-resumable attempt. Postgres, not queue retention, owns replay safety. */
export async function processVenueEmbeddingRefreshJob(payload: VenueEmbeddingRefreshJobPayload) {
  for (const key of ['tenantId', 'venueId', 'refreshId'] as const) {
    if (typeof payload?.[key] !== 'string' || !payload[key].trim() || payload[key].length > 200) {
      throw new UnrecoverableError('INVALID_EMBEDDING_REFRESH_SCOPE')
    }
  }
  const claimed = await claimVenueEmbeddingRefresh(payload)
  if (!claimed.acquired || !claimed.refresh) return claimed.refresh
  const run = claimed.refresh
  let attemptedRecordId: string | undefined
  let uncertainReceipt = false
  let code = 'REFRESH_PREFLIGHT_FAILED'
  try {
    if (
      process.env.EMBEDDING_DISPATCH_ENABLED !== 'false' ||
      env.EMBEDDING_DISPATCH_ENABLED !== false
    ) {
      code = 'DISPATCHER_MUST_BE_EXPLICITLY_DISABLED'
      throw new Error(code)
    }
    await assertVenueAiAvailable(db, payload)
    const plan = await planVenueEmbeddingRefresh(payload)
    if (
      !plan.eligible ||
      plan.truncated ||
      plan.blockedCount ||
      plan.planDigest !== run.planDigest ||
      plan.candidateCount > run.maxRecords ||
      plan.candidateCount !== run.records.length ||
      run.records.length > 1000 ||
      run.records.some((record, index) => {
        const sealed = plan.manifest[index]
        return !sealed || !sameIdentity(sealed, record) || record.status !== 'PENDING'
      })
    ) {
      code = 'SEALED_PLAN_CHANGED_OR_BLOCKED'
      throw new Error(code)
    }
    for (const record of [...run.records].sort((a, b) => a.ordinal - b.ordinal)) {
      code = 'RECORD_PREFLIGHT_FAILED'
      const currentRun = await getVenueEmbeddingRefresh(payload)
      if (currentRun?.status !== 'RUNNING') throw new Error(code)
      await assertVenueAiAvailable(db, payload)
      const before = await auditEmbeddingFreshness({ ...payload, manualRefresh: true })
      const current = before.candidates.find(
        (candidate) =>
          candidate.entityType === record.entityType && candidate.entityId === record.entityId,
      )
      if (
        before.truncated ||
        !sameIdentity(current, record) ||
        !current?.actionable ||
        before.candidates.some((candidate) =>
          [
            'current-running',
            'dispatch-leased',
            'complete-claim-missing-vector-invariant-breach',
          ].includes(candidate.primaryReason),
        )
      ) {
        code = 'RECORD_CHANGED_OR_BLOCKED'
        throw new Error(code)
      }
      // An uncertain CAS must never be followed by a provider invocation.
      uncertainReceipt = true
      const started = await startVenueEmbeddingRefreshRecord({ ...payload, recordId: record.id })
      if (!started.acquired) throw new Error('RECORD_CLAIM_NOT_ACQUIRED')
      uncertainReceipt = false
      attemptedRecordId = record.id
      code = 'RECORD_ATTEMPT_OUTCOME_UNKNOWN'
      const execution = {
        bullJobId: `${run.id}-${record.ordinal}`,
        attemptNumber: 1,
        maxAttempts: 1,
      }
      const common = {
        tenantId: payload.tenantId,
        expectedVenueId: payload.venueId,
        expectedSourceHash: record.sourceHash,
        expectedEmbeddingProfile: record.embeddingProfile,
        contentUpdatedAt: new Date(record.contentUpdatedAt).toISOString(),
      }
      if (record.entityType === 'PLACE')
        await processEmbedPlaceJob({ ...common, placeId: record.entityId }, execution)
      else await processEmbedKnowledgeEntryJob({ ...common, entryId: record.entityId }, execution)
      // A void result may have skipped disabled/stale content. Prove exact freshness.
      const after = await auditEmbeddingFreshness({ ...payload, manualRefresh: true })
      const observed = after.candidates.find(
        (candidate) =>
          candidate.entityType === record.entityType && candidate.entityId === record.entityId,
      )
      if (
        after.truncated ||
        !sameIdentity(observed, record) ||
        observed?.primaryReason !== 'current-complete'
      ) {
        throw new Error('RECORD_FRESHNESS_NOT_PROVEN')
      }
      const finished = await finishVenueEmbeddingRefreshRecord({
        ...payload,
        recordId: record.id,
        outcome: { status: 'COMPLETE' },
      })
      if (!finished.acquired) throw new Error('RECORD_RECEIPT_NOT_RECORDED')
      attemptedRecordId = undefined
    }
    code = 'FINAL_AUDIT_FAILED'
    await assertVenueAiAvailable(db, payload)
    const after = await planVenueEmbeddingRefresh(payload)
    if (!after.eligible) throw new Error('VENUE_NO_LONGER_ELIGIBLE')
    const completed = await completeVenueEmbeddingRefresh({
      ...payload,
      afterAudit: after.beforeAudit,
    })
    if (!completed.acquired) throw new Error('FINAL_RECEIPT_NOT_RECORDED')
    return completed.refresh
  } catch {
    // Keep the venue locked whenever a provider effect or receipt write is uncertain.
    try {
      if (attemptedRecordId)
        await finishVenueEmbeddingRefreshRecord({
          ...payload,
          recordId: attemptedRecordId,
          outcome: { status: 'OUTCOME_UNKNOWN', code },
        })
      await stopVenueEmbeddingRefresh({
        ...payload,
        code,
        unknown: !!attemptedRecordId || uncertainReceipt,
      })
      return await getVenueEmbeddingRefresh(payload)
    } catch {
      // Durable RUNNING is intentionally not stolen after a crash/database failure.
      throw new UnrecoverableError('EMBEDDING_REFRESH_RECEIPT_UNAVAILABLE')
    }
  }
}
