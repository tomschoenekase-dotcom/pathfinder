import type { EmbeddingWorkEntityType } from '@prisma/client'

import { db } from '../client'

export const EMBEDDING_FRESHNESS_CANARY_MAX = 10

export type EmbeddingFreshnessCanaryTarget = {
  entityType: EmbeddingWorkEntityType
  entityId: string
  contentUpdatedAt: Date
}

export async function insertEmbeddingFreshnessCanary(params: {
  tenantId: string
  venueId: string
  targets: EmbeddingFreshnessCanaryTarget[]
}): Promise<{ inserted: string[]; skipped: string[] }> {
  const uniqueTargets = Array.from(
    new Map(
      params.targets.map((target) => [`${target.entityType}:${target.entityId}`, target]),
    ).values(),
  )
  if (uniqueTargets.length === 0 || uniqueTargets.length > EMBEDDING_FRESHNESS_CANARY_MAX) {
    throw new Error(
      `Embedding freshness canary requires 1-${EMBEDDING_FRESHNESS_CANARY_MAX} unique targets`,
    )
  }

  return db.$transaction(async (tx) => {
    const inserted: string[] = []
    const skipped: string[] = []

    for (const target of uniqueTargets) {
      const dispatchId =
        target.entityType === 'PLACE' ? `place:${target.entityId}` : `knowledge:${target.entityId}`
      const insertedCount =
        target.entityType === 'PLACE'
          ? await tx.$executeRaw`
              INSERT INTO embedding_dispatches (
                id, tenant_id, venue_id, entity_type, entity_id, content_updated_at,
                attempts, next_attempt_at, lease_token, lease_expires_at, last_error,
                created_at, updated_at
              )
              SELECT
                ${dispatchId}, place.tenant_id, place.venue_id, 'PLACE', place.id, place.updated_at,
                0, clock_timestamp(), NULL, NULL, NULL, clock_timestamp(), clock_timestamp()
              FROM places AS place
              WHERE place.id = ${target.entityId}
                AND place.tenant_id = ${params.tenantId}
                AND place.venue_id = ${params.venueId}
                AND place.updated_at = ${target.contentUpdatedAt}
                AND place.is_active = TRUE
              ON CONFLICT (tenant_id, venue_id, entity_type, entity_id) DO NOTHING
            `
          : await tx.$executeRaw`
              INSERT INTO embedding_dispatches (
                id, tenant_id, venue_id, entity_type, entity_id, content_updated_at,
                attempts, next_attempt_at, lease_token, lease_expires_at, last_error,
                created_at, updated_at
              )
              SELECT
                ${dispatchId}, entry.tenant_id, entry.venue_id, 'KNOWLEDGE_ENTRY', entry.id, entry.updated_at,
                0, clock_timestamp(), NULL, NULL, NULL, clock_timestamp(), clock_timestamp()
              FROM venue_knowledge_entries AS entry
              WHERE entry.id = ${target.entityId}
                AND entry.tenant_id = ${params.tenantId}
                AND entry.venue_id = ${params.venueId}
                AND entry.updated_at = ${target.contentUpdatedAt}
                AND entry.is_enabled = TRUE
              ON CONFLICT (tenant_id, venue_id, entity_type, entity_id) DO NOTHING
            `

      if (insertedCount === 1) inserted.push(target.entityId)
      else skipped.push(target.entityId)
    }

    return { inserted, skipped }
  })
}
