import type { EmbeddingWorkEntityType } from '@prisma/client'

import { db } from '../client'
import { buildKnowledgeEntryText, buildPlaceText } from './content-text'
import { embeddingSourceHash } from './embedding-identity'

type ClaimRow = {
  id: string
  contentUpdatedAt: Date
  sourceHash: string
  embeddingProfile: string
  completedAt: Date
}

type EntityRow = {
  id: string
  updatedAt: Date
  hasEmbedding: boolean
  isEligible: boolean
  name: string | null
  type: string | null
  itemType: string | null
  shortDescription: string | null
  longDescription: string | null
  tags: string[] | null
  areaName: string | null
  hours: string | null
  title: string | null
  category: string | null
  content: string | null
}

type DispatchRow = {
  id: string
  contentUpdatedAt: Date
  leaseToken: string | null
  leaseExpiresAt: Date | null
}

export type RepairCompleteClaimResult =
  | { state: 'repaired'; claimId: string; dispatchId: string; dispatchInserted: boolean }
  | {
      state: 'refused'
      reason:
        | 'claim-not-exact-complete'
        | 'entity-not-eligible'
        | 'vector-present'
        | 'source-mismatch'
        | 'profile-mismatch'
        | 'dispatch-conflict'
    }

export async function repairCompleteClaimMissingVector(params: {
  tenantId: string
  venueId: string
  entityType: EmbeddingWorkEntityType
  entityId: string
  expectedProfile: string
  actorId: string
}): Promise<RepairCompleteClaimResult> {
  if (process.env.RAILWAY_ENVIRONMENT !== 'staging') {
    throw new Error('Embedding claim repair mutation requires RAILWAY_ENVIRONMENT=staging')
  }
  if (process.env.EMBEDDING_DISPATCH_ENABLED !== 'false') {
    throw new Error('Embedding claim repair mutation requires EMBEDDING_DISPATCH_ENABLED=false')
  }
  return db.$transaction(async (tx) => {
    const claims = await tx.$queryRaw<ClaimRow[]>`
      SELECT
        id,
        content_updated_at AS "contentUpdatedAt",
        source_hash AS "sourceHash",
        embedding_profile AS "embeddingProfile",
        completed_at AS "completedAt"
      FROM embedding_work_claims
      WHERE tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND entity_type = ${params.entityType}::"EmbeddingWorkEntityType"
        AND entity_id = ${params.entityId}
        AND status = 'COMPLETE'
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
        AND completed_at IS NOT NULL
      FOR UPDATE
    `
    const claim = claims[0]
    if (!claim) return { state: 'refused', reason: 'claim-not-exact-complete' }
    if (claim.embeddingProfile !== params.expectedProfile) {
      return { state: 'refused', reason: 'profile-mismatch' }
    }

    const entities =
      params.entityType === 'PLACE'
        ? await tx.$queryRaw<EntityRow[]>`
            SELECT
              id, updated_at AS "updatedAt", embedding IS NOT NULL AS "hasEmbedding",
              is_active AS "isEligible", name, type, item_type AS "itemType",
              short_description AS "shortDescription", long_description AS "longDescription",
              tags, area_name AS "areaName", hours,
              NULL::text AS title, NULL::text AS category, NULL::text AS content
            FROM places
            WHERE tenant_id = ${params.tenantId}
              AND venue_id = ${params.venueId}
              AND id = ${params.entityId}
            FOR UPDATE
          `
        : await tx.$queryRaw<EntityRow[]>`
            SELECT
              id, updated_at AS "updatedAt", embedding IS NOT NULL AS "hasEmbedding",
              is_enabled AS "isEligible", NULL::text AS name, NULL::text AS type,
              NULL::text AS "itemType", NULL::text AS "shortDescription",
              NULL::text AS "longDescription", NULL::text[] AS tags,
              NULL::text AS "areaName", NULL::text AS hours,
              title, category, content
            FROM venue_knowledge_entries
            WHERE tenant_id = ${params.tenantId}
              AND venue_id = ${params.venueId}
              AND id = ${params.entityId}
            FOR UPDATE
          `
    const entity = entities[0]
    if (!entity?.isEligible) return { state: 'refused', reason: 'entity-not-eligible' }
    if (entity.hasEmbedding) return { state: 'refused', reason: 'vector-present' }

    const sourceText =
      params.entityType === 'PLACE'
        ? buildPlaceText({
            name: entity.name!,
            type: entity.type!,
            itemType: entity.itemType,
            shortDescription: entity.shortDescription,
            longDescription: entity.longDescription,
            tags: entity.tags ?? [],
            areaName: entity.areaName,
            hours: entity.hours,
          })
        : buildKnowledgeEntryText({
            title: entity.title!,
            category: entity.category!,
            content: entity.content!,
          })
    const currentHash = embeddingSourceHash(
      params.entityType === 'PLACE' ? 'place' : 'knowledge-entry',
      sourceText,
    )
    if (currentHash !== claim.sourceHash) return { state: 'refused', reason: 'source-mismatch' }

    const dispatches = await tx.$queryRaw<DispatchRow[]>`
      SELECT
        id, content_updated_at AS "contentUpdatedAt",
        lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt"
      FROM embedding_dispatches
      WHERE tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND entity_type = ${params.entityType}::"EmbeddingWorkEntityType"
        AND entity_id = ${params.entityId}
      FOR UPDATE
    `
    let dispatch = dispatches[0]
    let dispatchInserted = false
    const dispatchId =
      params.entityType === 'PLACE' ? `place:${params.entityId}` : `knowledge:${params.entityId}`

    if (
      dispatch &&
      (dispatch.contentUpdatedAt.getTime() !== entity.updatedAt.getTime() ||
        dispatch.leaseToken !== null ||
        dispatch.leaseExpiresAt !== null)
    ) {
      return { state: 'refused', reason: 'dispatch-conflict' }
    }

    if (!dispatch) {
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO embedding_dispatches (
          id, tenant_id, venue_id, entity_type, entity_id, content_updated_at,
          attempts, next_attempt_at, lease_token, lease_expires_at, last_error,
          created_at, updated_at
        ) VALUES (
          ${dispatchId}, ${params.tenantId}, ${params.venueId},
          ${params.entityType}::"EmbeddingWorkEntityType", ${params.entityId}, ${entity.updatedAt},
          0, clock_timestamp(), NULL, NULL, NULL, clock_timestamp(), clock_timestamp()
        )
        ON CONFLICT (tenant_id, venue_id, entity_type, entity_id) DO NOTHING
        RETURNING id
      `
      dispatchInserted = inserted.length === 1
      const current = await tx.$queryRaw<DispatchRow[]>`
        SELECT
          id, content_updated_at AS "contentUpdatedAt",
          lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt"
        FROM embedding_dispatches
        WHERE tenant_id = ${params.tenantId}
          AND venue_id = ${params.venueId}
          AND entity_type = ${params.entityType}::"EmbeddingWorkEntityType"
          AND entity_id = ${params.entityId}
        FOR UPDATE
      `
      dispatch = current[0]
    }

    if (
      !dispatch ||
      dispatch.contentUpdatedAt.getTime() !== entity.updatedAt.getTime() ||
      dispatch.leaseToken !== null ||
      dispatch.leaseExpiresAt !== null
    ) {
      throw new Error('Embedding claim repair refused unsafe dispatch conflict')
    }

    const updated = await tx.$executeRaw`
      UPDATE embedding_work_claims
      SET status = 'SUPERSEDED', updated_at = clock_timestamp()
      WHERE id = ${claim.id}
        AND tenant_id = ${params.tenantId}
        AND venue_id = ${params.venueId}
        AND entity_type = ${params.entityType}::"EmbeddingWorkEntityType"
        AND entity_id = ${params.entityId}
        AND status = 'COMPLETE'
        AND content_updated_at = ${claim.contentUpdatedAt}
        AND source_hash = ${claim.sourceHash}
        AND embedding_profile = ${claim.embeddingProfile}
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
    `
    if (updated !== 1) throw new Error('Embedding claim changed during invariant repair')

    await tx.auditLog.create({
      data: {
        tenantId: params.tenantId,
        actorId: `operator-asserted:${params.actorId}`,
        actorRole: 'operator-asserted',
        action: 'embedding.claim-invariant-repaired',
        targetType: 'EmbeddingWorkClaim',
        targetId: claim.id,
        beforeState: {
          status: 'COMPLETE',
          entityType: params.entityType,
          entityId: params.entityId,
          contentUpdatedAt: claim.contentUpdatedAt.toISOString(),
          sourceHash: claim.sourceHash,
          embeddingProfile: claim.embeddingProfile,
          completedAt: claim.completedAt.toISOString(),
        },
        afterState: {
          status: 'SUPERSEDED',
          dispatchId: dispatch.id,
          dispatchRevision: entity.updatedAt.toISOString(),
          dispatchInserted,
          actorIdentitySource: 'operator-asserted-cli',
        },
      },
    })

    return { state: 'repaired', claimId: claim.id, dispatchId: dispatch.id, dispatchInserted }
  })
}
