const EMBEDDING_DIMENSIONS = 1_536
const MAX_DRAFT_ITEMS = 500

// The raw-SQL boundary verifier intentionally rejects computed Prisma method
// references. Keep this structural client local and audit each tagged query by
// its exact template hash in scripts/verify-raw-sql-boundary.mjs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SemanticClient = any

export type SemanticVectorCoverage = {
  eligibleCount: number
  searchableCount: number
  missingVectorCount: number
  incompatibleVectorCount: number
}

export type VenuePackageSemanticCoverage = {
  places: SemanticVectorCoverage
  knowledgeEntries: SemanticVectorCoverage
}

export type VenuePackageSemanticDuplicateCandidate = {
  draftIndex: number
  embedding: number[]
  excludeId?: string
}

export type VenuePackageSemanticDuplicateMatch = {
  entityType: 'PLACE' | 'KNOWLEDGE_ENTRY'
  draftIndex: number
  existingId: string
  existingLabel: string
  cosineDistance: number
}

type CoverageRow = {
  place_eligible: number
  place_searchable: number
  place_missing: number
  place_incompatible: number
  knowledge_eligible: number
  knowledge_searchable: number
  knowledge_missing: number
  knowledge_incompatible: number
}

type MatchRow = {
  draft_index: number
  existing_id: string
  existing_label: string
  cosine_distance: number
}

function count(value: number): number {
  return Number(value)
}

function validateScope(params: { tenantId: string; venueId: string; profile: string }): void {
  if (!params.tenantId || !params.venueId || !params.profile) {
    throw new Error('Semantic duplicate scope and profile are required')
  }
}

function candidateJson(candidates: VenuePackageSemanticDuplicateCandidate[]): string {
  if (candidates.length > MAX_DRAFT_ITEMS) {
    throw new Error(`Semantic duplicate candidates cannot exceed ${MAX_DRAFT_ITEMS}`)
  }
  const seen = new Set<number>()
  return JSON.stringify(
    candidates.map((candidate) => {
      if (
        !Number.isInteger(candidate.draftIndex) ||
        candidate.draftIndex < 0 ||
        seen.has(candidate.draftIndex)
      ) {
        throw new Error('Semantic duplicate draft indexes must be unique nonnegative integers')
      }
      seen.add(candidate.draftIndex)
      if (
        candidate.embedding.length !== EMBEDDING_DIMENSIONS ||
        candidate.embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(
          `Semantic duplicate embeddings must contain ${EMBEDDING_DIMENSIONS} finite values`,
        )
      }
      return {
        draftIndex: candidate.draftIndex,
        vectorText: `[${candidate.embedding.join(',')}]`,
        excludeId: candidate.excludeId ?? null,
      }
    }),
  )
}

function validateDistance(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error('Semantic duplicate cosine distance must be between 0 and 2')
  }
}

export async function getVenuePackageSemanticCoverage(
  client: SemanticClient,
  params: {
    tenantId: string
    venueId: string
    placeProfile: string
    knowledgeProfile: string
    scanPlaces: boolean
    scanKnowledgeEntries: boolean
    excludedPlaceIds?: string[]
    excludedKnowledgeEntryIds?: string[]
  },
): Promise<VenuePackageSemanticCoverage> {
  validateScope({ ...params, profile: params.placeProfile })
  validateScope({ ...params, profile: params.knowledgeProfile })
  const excludedPlaceIds = JSON.stringify(params.excludedPlaceIds ?? [])
  const excludedKnowledgeEntryIds = JSON.stringify(params.excludedKnowledgeEntryIds ?? [])

  const rows = await client.$queryRaw<CoverageRow[]>`
    WITH place_coverage AS MATERIALIZED (
      SELECT
        COUNT(*)::int AS eligible,
        COUNT(*) FILTER (
          WHERE p.embedding IS NOT NULL AND claim.id IS NOT NULL
        )::int AS searchable,
        COUNT(*) FILTER (WHERE p.embedding IS NULL)::int AS missing,
        COUNT(*) FILTER (
          WHERE p.embedding IS NOT NULL AND claim.id IS NULL
        )::int AS incompatible
      FROM places p
      LEFT JOIN embedding_work_claims claim
        ON claim.tenant_id = p.tenant_id
       AND claim.venue_id = p.venue_id
       AND claim.entity_type = 'PLACE'
       AND claim.entity_id = p.id
       AND claim.status = 'COMPLETE'
       AND claim.completed_at IS NOT NULL
       AND claim.content_updated_at = p.updated_at
       AND claim.embedding_profile = ${params.placeProfile}
      WHERE ${params.scanPlaces}
        AND p.tenant_id = ${params.tenantId}
        AND p.venue_id = ${params.venueId}
        AND p.is_active = true
        AND p.id NOT IN (SELECT jsonb_array_elements_text(${excludedPlaceIds}::jsonb))
    ),
    knowledge_coverage AS MATERIALIZED (
      SELECT
        COUNT(*)::int AS eligible,
        COUNT(*) FILTER (
          WHERE k.embedding IS NOT NULL AND claim.id IS NOT NULL
        )::int AS searchable,
        COUNT(*) FILTER (WHERE k.embedding IS NULL)::int AS missing,
        COUNT(*) FILTER (
          WHERE k.embedding IS NOT NULL AND claim.id IS NULL
        )::int AS incompatible
      FROM venue_knowledge_entries k
      LEFT JOIN embedding_work_claims claim
        ON claim.tenant_id = k.tenant_id
       AND claim.venue_id = k.venue_id
       AND claim.entity_type = 'KNOWLEDGE_ENTRY'
       AND claim.entity_id = k.id
       AND claim.status = 'COMPLETE'
       AND claim.completed_at IS NOT NULL
       AND claim.content_updated_at = k.updated_at
       AND claim.embedding_profile = ${params.knowledgeProfile}
      WHERE ${params.scanKnowledgeEntries}
        AND k.tenant_id = ${params.tenantId}
        AND k.venue_id = ${params.venueId}
        AND k.is_enabled = true
        AND k.id NOT IN (SELECT jsonb_array_elements_text(${excludedKnowledgeEntryIds}::jsonb))
    )
    SELECT
      p.eligible AS place_eligible,
      p.searchable AS place_searchable,
      p.missing AS place_missing,
      p.incompatible AS place_incompatible,
      k.eligible AS knowledge_eligible,
      k.searchable AS knowledge_searchable,
      k.missing AS knowledge_missing,
      k.incompatible AS knowledge_incompatible
    FROM place_coverage p
    CROSS JOIN knowledge_coverage k
  `
  const row = rows[0]
  if (!row) throw new Error('Semantic duplicate coverage query returned no row')
  return {
    places: {
      eligibleCount: count(row.place_eligible),
      searchableCount: count(row.place_searchable),
      missingVectorCount: count(row.place_missing),
      incompatibleVectorCount: count(row.place_incompatible),
    },
    knowledgeEntries: {
      eligibleCount: count(row.knowledge_eligible),
      searchableCount: count(row.knowledge_searchable),
      missingVectorCount: count(row.knowledge_missing),
      incompatibleVectorCount: count(row.knowledge_incompatible),
    },
  }
}

export async function findVenuePackagePlaceSemanticDuplicates(
  client: SemanticClient,
  params: {
    tenantId: string
    venueId: string
    profile: string
    maxCosineDistance: number
    candidates: VenuePackageSemanticDuplicateCandidate[]
  },
): Promise<VenuePackageSemanticDuplicateMatch[]> {
  validateScope(params)
  validateDistance(params.maxCosineDistance)
  if (params.candidates.length === 0) return []
  const candidates = candidateJson(params.candidates)
  const rows = await client.$queryRaw<MatchRow[]>`
    WITH draft_candidates AS MATERIALIZED (
      SELECT
        (value ->> 'draftIndex')::int AS draft_index,
        (value ->> 'vectorText')::vector(1536) AS embedding,
        value ->> 'excludeId' AS exclude_id
      FROM jsonb_array_elements(${candidates}::jsonb) AS value
    ),
    existing_candidates AS MATERIALIZED (
      SELECT p.id, p.name AS label, p.embedding
      FROM places p
      INNER JOIN embedding_work_claims claim
        ON claim.tenant_id = p.tenant_id
       AND claim.venue_id = p.venue_id
       AND claim.entity_type = 'PLACE'
       AND claim.entity_id = p.id
       AND claim.status = 'COMPLETE'
       AND claim.completed_at IS NOT NULL
       AND claim.content_updated_at = p.updated_at
       AND claim.embedding_profile = ${params.profile}
      WHERE p.tenant_id = ${params.tenantId}
        AND p.venue_id = ${params.venueId}
        AND p.is_active = true
        AND p.embedding IS NOT NULL
    )
    SELECT
      draft.draft_index,
      matched.id AS existing_id,
      matched.label AS existing_label,
      matched.cosine_distance
    FROM draft_candidates draft
    CROSS JOIN LATERAL (
      SELECT
        existing.id,
        existing.label,
        (existing.embedding <=> draft.embedding)::double precision AS cosine_distance
      FROM existing_candidates existing
      WHERE (existing.embedding <=> draft.embedding) <= ${params.maxCosineDistance}
        AND (draft.exclude_id IS NULL OR existing.id <> draft.exclude_id)
      ORDER BY (existing.embedding <=> draft.embedding) ASC, existing.id ASC
      LIMIT 1
    ) matched
    ORDER BY draft.draft_index ASC, matched.cosine_distance ASC, matched.id ASC
  `
  return rows.map((row: MatchRow) => ({
    entityType: 'PLACE',
    draftIndex: count(row.draft_index),
    existingId: row.existing_id,
    existingLabel: row.existing_label,
    cosineDistance: Number(row.cosine_distance),
  }))
}

export async function findVenuePackageKnowledgeSemanticDuplicates(
  client: SemanticClient,
  params: {
    tenantId: string
    venueId: string
    profile: string
    maxCosineDistance: number
    candidates: VenuePackageSemanticDuplicateCandidate[]
  },
): Promise<VenuePackageSemanticDuplicateMatch[]> {
  validateScope(params)
  validateDistance(params.maxCosineDistance)
  if (params.candidates.length === 0) return []
  const candidates = candidateJson(params.candidates)
  const rows = await client.$queryRaw<MatchRow[]>`
    WITH draft_candidates AS MATERIALIZED (
      SELECT
        (value ->> 'draftIndex')::int AS draft_index,
        (value ->> 'vectorText')::vector(1536) AS embedding,
        value ->> 'excludeId' AS exclude_id
      FROM jsonb_array_elements(${candidates}::jsonb) AS value
    ),
    existing_candidates AS MATERIALIZED (
      SELECT k.id, k.title AS label, k.embedding
      FROM venue_knowledge_entries k
      INNER JOIN embedding_work_claims claim
        ON claim.tenant_id = k.tenant_id
       AND claim.venue_id = k.venue_id
       AND claim.entity_type = 'KNOWLEDGE_ENTRY'
       AND claim.entity_id = k.id
       AND claim.status = 'COMPLETE'
       AND claim.completed_at IS NOT NULL
       AND claim.content_updated_at = k.updated_at
       AND claim.embedding_profile = ${params.profile}
      WHERE k.tenant_id = ${params.tenantId}
        AND k.venue_id = ${params.venueId}
        AND k.is_enabled = true
        AND k.embedding IS NOT NULL
    )
    SELECT
      draft.draft_index,
      matched.id AS existing_id,
      matched.label AS existing_label,
      matched.cosine_distance
    FROM draft_candidates draft
    CROSS JOIN LATERAL (
      SELECT
        existing.id,
        existing.label,
        (existing.embedding <=> draft.embedding)::double precision AS cosine_distance
      FROM existing_candidates existing
      WHERE (existing.embedding <=> draft.embedding) <= ${params.maxCosineDistance}
        AND (draft.exclude_id IS NULL OR existing.id <> draft.exclude_id)
      ORDER BY (existing.embedding <=> draft.embedding) ASC, existing.id ASC
      LIMIT 1
    ) matched
    ORDER BY draft.draft_index ASC, matched.cosine_distance ASC, matched.id ASC
  `
  return rows.map((row: MatchRow) => ({
    entityType: 'KNOWLEDGE_ENTRY',
    draftIndex: count(row.draft_index),
    existingId: row.existing_id,
    existingLabel: row.existing_label,
    cosineDistance: Number(row.cosine_distance),
  }))
}
