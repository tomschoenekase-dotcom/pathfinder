import { AI_EMBEDDING_MODEL_KEYS, getAiEmbeddingProfile } from '@pathfinder/ai'
import { buildKnowledgeEntryText, buildPlaceText, db, embeddingSourceHash } from '@pathfinder/db'

export const EMBEDDING_FRESHNESS_PAGE_SIZE = 200
export const EMBEDDING_FRESHNESS_SCAN_CAP = 10_000

export const ACTIONABLE_EMBEDDING_FRESHNESS_REASONS = [
  'missing-vector-no-claim',
  'legacy-vector-no-claim',
  'complete-profile-mismatch',
  'complete-source-mismatch',
  'superseded-claim',
  'expired-running-claim',
  'running-stale-identity',
] as const

export type ActionableEmbeddingFreshnessReason =
  (typeof ACTIONABLE_EMBEDDING_FRESHNESS_REASONS)[number]

export type EmbeddingFreshnessReason =
  | ActionableEmbeddingFreshnessReason
  | 'current-complete'
  | 'current-complete-revision-drift'
  | 'current-running'
  | 'dispatch-due'
  | 'dispatch-backoff'
  | 'dispatch-leased'
  | 'dispatch-expired-lease'
  | 'complete-claim-missing-vector-invariant-breach'

type ClaimStatus = 'RUNNING' | 'COMPLETE' | 'SUPERSEDED'

type BaseAuditRow = {
  id: string
  tenantId: string
  venueId: string
  updatedAt: Date
  hasEmbedding: boolean
  claimStatus: ClaimStatus | null
  claimUpdatedAt: Date | null
  claimSourceHash: string | null
  claimEmbeddingProfile: string | null
  claimLeaseExpiresAt: Date | null
  dispatchId: string | null
  dispatchNextAttemptAt: Date | null
  dispatchLeaseToken: string | null
  dispatchLeaseExpiresAt: Date | null
  observedAt: Date
}

type PlaceAuditRow = BaseAuditRow & {
  name: string
  type: string
  itemType: string | null
  shortDescription: string | null
  longDescription: string | null
  tags: string[]
  areaName: string | null
  hours: string | null
}

type KnowledgeAuditRow = BaseAuditRow & {
  title: string
  category: string
  content: string
}

type EmbeddingAuditClient = Omit<
  typeof db,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>

export type EmbeddingFreshnessCandidate = {
  entityType: 'PLACE' | 'KNOWLEDGE_ENTRY'
  entityId: string
  tenantId: string
  venueId: string
  contentUpdatedAt: Date
  primaryReason: EmbeddingFreshnessReason
  signals: string[]
  actionable: boolean
}

export type EmbeddingFreshnessAudit = {
  tenantId: string
  venueId: string | null
  scanned: number
  truncated: boolean
  groups: Array<{
    venueId: string
    entityType: 'PLACE' | 'KNOWLEDGE_ENTRY'
    reason: EmbeddingFreshnessReason
    count: number
  }>
  actionableCandidates: EmbeddingFreshnessCandidate[]
}

function dispatchReason(row: BaseAuditRow): EmbeddingFreshnessReason | null {
  if (!row.dispatchId) return null
  if (row.dispatchLeaseToken) {
    return row.dispatchLeaseExpiresAt && row.dispatchLeaseExpiresAt > row.observedAt
      ? 'dispatch-leased'
      : 'dispatch-expired-lease'
  }
  return row.dispatchNextAttemptAt && row.dispatchNextAttemptAt > row.observedAt
    ? 'dispatch-backoff'
    : 'dispatch-due'
}

export function classifyEmbeddingFreshness(params: {
  row: BaseAuditRow
  entityType: 'PLACE' | 'KNOWLEDGE_ENTRY'
  expectedSourceHash: string
  expectedProfile: string
}): EmbeddingFreshnessCandidate {
  const { row } = params
  const signals = [
    ...(row.claimStatus && row.claimUpdatedAt?.getTime() !== row.updatedAt.getTime()
      ? ['revision-mismatch']
      : []),
    ...(row.claimStatus && row.claimSourceHash !== params.expectedSourceHash
      ? ['source-mismatch']
      : []),
    ...(row.claimStatus && row.claimEmbeddingProfile !== params.expectedProfile
      ? ['profile-mismatch']
      : []),
    ...(!row.hasEmbedding ? ['missing-vector'] : []),
  ]
  let primaryReason: EmbeddingFreshnessReason
  const dispatch = dispatchReason(row)

  if (dispatch) primaryReason = dispatch
  else if (!row.claimStatus)
    primaryReason = row.hasEmbedding ? 'legacy-vector-no-claim' : 'missing-vector-no-claim'
  else if (row.claimStatus === 'COMPLETE') {
    if (
      row.claimSourceHash === params.expectedSourceHash &&
      row.claimEmbeddingProfile === params.expectedProfile
    ) {
      primaryReason = !row.hasEmbedding
        ? 'complete-claim-missing-vector-invariant-breach'
        : row.claimUpdatedAt?.getTime() !== row.updatedAt.getTime()
          ? 'current-complete-revision-drift'
          : 'current-complete'
    } else if (row.claimEmbeddingProfile !== params.expectedProfile)
      primaryReason = 'complete-profile-mismatch'
    else if (row.claimSourceHash !== params.expectedSourceHash)
      primaryReason = 'complete-source-mismatch'
    else primaryReason = 'complete-source-mismatch'
  } else if (row.claimStatus === 'SUPERSEDED') primaryReason = 'superseded-claim'
  else if (
    row.claimUpdatedAt?.getTime() === row.updatedAt.getTime() &&
    row.claimSourceHash === params.expectedSourceHash &&
    row.claimEmbeddingProfile === params.expectedProfile &&
    row.claimLeaseExpiresAt &&
    row.claimLeaseExpiresAt > row.observedAt
  )
    primaryReason = 'current-running'
  else if (row.claimLeaseExpiresAt && row.claimLeaseExpiresAt <= row.observedAt)
    primaryReason = 'expired-running-claim'
  else primaryReason = 'running-stale-identity'

  return {
    entityType: params.entityType,
    entityId: row.id,
    tenantId: row.tenantId,
    venueId: row.venueId,
    contentUpdatedAt: row.updatedAt,
    primaryReason,
    signals,
    actionable: (ACTIONABLE_EMBEDDING_FRESHNESS_REASONS as readonly string[]).includes(
      primaryReason,
    ),
  }
}

async function readPlacePage(
  client: EmbeddingAuditClient,
  params: {
    tenantId: string
    venueId?: string
    cursor?: string
    take: number
  },
): Promise<PlaceAuditRow[]> {
  return client.$queryRaw<PlaceAuditRow[]>`
    SELECT place.id,
           place.tenant_id AS "tenantId",
           place.venue_id AS "venueId",
           place.updated_at AS "updatedAt",
           place.embedding IS NOT NULL AS "hasEmbedding",
           place.name,
           place.type,
           place.item_type AS "itemType",
           place.short_description AS "shortDescription",
           place.long_description AS "longDescription",
           place.tags,
           place.area_name AS "areaName",
           place.hours,
           claim.status AS "claimStatus",
           claim.content_updated_at AS "claimUpdatedAt",
           claim.source_hash AS "claimSourceHash",
           claim.embedding_profile AS "claimEmbeddingProfile",
           claim.lease_expires_at AS "claimLeaseExpiresAt",
           dispatch.id AS "dispatchId",
           dispatch.next_attempt_at AS "dispatchNextAttemptAt",
           dispatch.lease_token AS "dispatchLeaseToken",
           dispatch.lease_expires_at AS "dispatchLeaseExpiresAt",
           clock_timestamp() AS "observedAt"
    FROM places AS place
    LEFT JOIN embedding_work_claims AS claim
      ON claim.tenant_id = place.tenant_id
      AND claim.venue_id = place.venue_id
      AND claim.entity_type = 'PLACE'
      AND claim.entity_id = place.id
    LEFT JOIN embedding_dispatches AS dispatch
      ON dispatch.tenant_id = place.tenant_id
      AND dispatch.venue_id = place.venue_id
      AND dispatch.entity_type = 'PLACE'
      AND dispatch.entity_id = place.id
    WHERE place.tenant_id = ${params.tenantId}
      AND (${params.venueId ?? null}::text IS NULL OR place.venue_id = ${params.venueId ?? null})
      AND (${params.cursor ?? null}::text IS NULL OR place.id > ${params.cursor ?? null})
      AND place.is_active = TRUE
    ORDER BY place.id ASC
    LIMIT ${params.take}
  `
}

async function readKnowledgePage(
  client: EmbeddingAuditClient,
  params: {
    tenantId: string
    venueId?: string
    cursor?: string
    take: number
  },
): Promise<KnowledgeAuditRow[]> {
  return client.$queryRaw<KnowledgeAuditRow[]>`
    SELECT entry.id,
           entry.tenant_id AS "tenantId",
           entry.venue_id AS "venueId",
           entry.updated_at AS "updatedAt",
           entry.embedding IS NOT NULL AS "hasEmbedding",
           entry.title,
           entry.category,
           entry.content,
           claim.status AS "claimStatus",
           claim.content_updated_at AS "claimUpdatedAt",
           claim.source_hash AS "claimSourceHash",
           claim.embedding_profile AS "claimEmbeddingProfile",
           claim.lease_expires_at AS "claimLeaseExpiresAt",
           dispatch.id AS "dispatchId",
           dispatch.next_attempt_at AS "dispatchNextAttemptAt",
           dispatch.lease_token AS "dispatchLeaseToken",
           dispatch.lease_expires_at AS "dispatchLeaseExpiresAt",
           clock_timestamp() AS "observedAt"
    FROM venue_knowledge_entries AS entry
    LEFT JOIN embedding_work_claims AS claim
      ON claim.tenant_id = entry.tenant_id
      AND claim.venue_id = entry.venue_id
      AND claim.entity_type = 'KNOWLEDGE_ENTRY'
      AND claim.entity_id = entry.id
    LEFT JOIN embedding_dispatches AS dispatch
      ON dispatch.tenant_id = entry.tenant_id
      AND dispatch.venue_id = entry.venue_id
      AND dispatch.entity_type = 'KNOWLEDGE_ENTRY'
      AND dispatch.entity_id = entry.id
    WHERE entry.tenant_id = ${params.tenantId}
      AND (${params.venueId ?? null}::text IS NULL OR entry.venue_id = ${params.venueId ?? null})
      AND (${params.cursor ?? null}::text IS NULL OR entry.id > ${params.cursor ?? null})
      AND entry.is_enabled = TRUE
    ORDER BY entry.id ASC
    LIMIT ${params.take}
  `
}

export async function auditEmbeddingFreshness(params: {
  tenantId: string
  venueId?: string
  scanCap?: number
}): Promise<EmbeddingFreshnessAudit> {
  return db.$transaction(
    async (tx) => {
      const scanCap = Math.max(1, Math.min(EMBEDDING_FRESHNESS_SCAN_CAP, params.scanCap ?? 10_000))
      const candidates: EmbeddingFreshnessCandidate[] = []
      let remaining = scanCap
      let truncated = false

      const placeProfile = getAiEmbeddingProfile(AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT)
      let placeCursor: string | undefined
      while (remaining > 0) {
        const take = Math.min(EMBEDDING_FRESHNESS_PAGE_SIZE, remaining)
        const rows = await readPlacePage(tx, {
          tenantId: params.tenantId,
          ...(params.venueId ? { venueId: params.venueId } : {}),
          ...(placeCursor ? { cursor: placeCursor } : {}),
          take: take + 1,
        })
        if (rows.length > take) truncated = true
        for (const row of rows.slice(0, take)) {
          const text = buildPlaceText(row)
          candidates.push(
            classifyEmbeddingFreshness({
              row,
              entityType: 'PLACE',
              expectedSourceHash: embeddingSourceHash('place', text),
              expectedProfile: placeProfile,
            }),
          )
        }
        remaining -= Math.min(rows.length, take)
        if (rows.length <= take) break
        placeCursor = rows[take - 1]!.id
      }

      const knowledgeProfile = getAiEmbeddingProfile(AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT)
      let knowledgeCursor: string | undefined
      while (remaining > 0) {
        const take = Math.min(EMBEDDING_FRESHNESS_PAGE_SIZE, remaining)
        const rows = await readKnowledgePage(tx, {
          tenantId: params.tenantId,
          ...(params.venueId ? { venueId: params.venueId } : {}),
          ...(knowledgeCursor ? { cursor: knowledgeCursor } : {}),
          take: take + 1,
        })
        if (rows.length > take) truncated = true
        for (const row of rows.slice(0, take)) {
          const text = buildKnowledgeEntryText(row)
          candidates.push(
            classifyEmbeddingFreshness({
              row,
              entityType: 'KNOWLEDGE_ENTRY',
              expectedSourceHash: embeddingSourceHash('knowledge-entry', text),
              expectedProfile: knowledgeProfile,
            }),
          )
        }
        remaining -= Math.min(rows.length, take)
        if (rows.length <= take) break
        knowledgeCursor = rows[take - 1]!.id
      }

      if (remaining === 0) truncated = true
      const grouped = new Map<string, EmbeddingFreshnessAudit['groups'][number]>()
      for (const candidate of candidates) {
        const key = `${candidate.venueId}\0${candidate.entityType}\0${candidate.primaryReason}`
        const existing = grouped.get(key)
        if (existing) existing.count += 1
        else
          grouped.set(key, {
            venueId: candidate.venueId,
            entityType: candidate.entityType,
            reason: candidate.primaryReason,
            count: 1,
          })
      }

      return {
        tenantId: params.tenantId,
        venueId: params.venueId ?? null,
        scanned: candidates.length,
        truncated,
        groups: Array.from(grouped.values()).sort((a, b) =>
          `${a.venueId}:${a.entityType}:${a.reason}`.localeCompare(
            `${b.venueId}:${b.entityType}:${b.reason}`,
          ),
        ),
        actionableCandidates: candidates.filter((candidate) => candidate.actionable),
      }
    },
    {
      isolationLevel: 'RepeatableRead',
      maxWait: 5_000,
      timeout: 30_000,
    },
  )
}
