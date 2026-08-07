import { randomUUID } from 'node:crypto'

import type { EmbeddingWorkEntityType } from '@prisma/client'

import { db } from '../client'

export const EMBEDDING_WORK_LEASE_MS = 30_000

export type EmbeddingWorkIdentity = {
  tenantId: string
  venueId: string
  entityType: EmbeddingWorkEntityType
  entityId: string
  contentUpdatedAt: Date
  sourceHash: string
  embeddingProfile: string
}

export type AcquireEmbeddingWorkParams = EmbeddingWorkIdentity & { leaseToken: string }
export type EmbeddingWorkAcquisition =
  | { state: 'acquired'; claimId: string }
  | { state: 'complete' }
  | { state: 'leased' }

type ClaimRow = {
  id: string
  status: 'RUNNING' | 'COMPLETE' | 'SUPERSEDED'
  contentUpdatedAt: Date
  sourceHash: string
  embeddingProfile: string
}

export async function acquireEmbeddingWork(
  params: AcquireEmbeddingWorkParams,
): Promise<EmbeddingWorkAcquisition> {
  const acquired = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO embedding_work_claims (
      id, tenant_id, venue_id, entity_type, entity_id, content_updated_at,
      source_hash, embedding_profile, status, lease_token, lease_expires_at,
      completed_at, created_at, updated_at
    ) VALUES (
      ${randomUUID()}, ${params.tenantId}, ${params.venueId},
      ${params.entityType}::"EmbeddingWorkEntityType", ${params.entityId},
      ${params.contentUpdatedAt}, ${params.sourceHash}, ${params.embeddingProfile},
      'RUNNING', ${params.leaseToken}, clock_timestamp() + ${EMBEDDING_WORK_LEASE_MS} * INTERVAL '1 millisecond',
      NULL, clock_timestamp(), clock_timestamp()
    )
    ON CONFLICT (tenant_id, venue_id, entity_type, entity_id) DO UPDATE SET
      content_updated_at = EXCLUDED.content_updated_at,
      source_hash = EXCLUDED.source_hash,
      embedding_profile = EXCLUDED.embedding_profile,
      status = 'RUNNING',
      lease_token = EXCLUDED.lease_token,
      lease_expires_at = clock_timestamp() + ${EMBEDDING_WORK_LEASE_MS} * INTERVAL '1 millisecond',
      completed_at = NULL,
      updated_at = clock_timestamp()
    WHERE
      (embedding_work_claims.status = 'RUNNING' AND embedding_work_claims.lease_expires_at <= clock_timestamp())
      OR embedding_work_claims.status = 'SUPERSEDED'
      OR (
        embedding_work_claims.status = 'COMPLETE'
        AND (
          embedding_work_claims.content_updated_at IS DISTINCT FROM EXCLUDED.content_updated_at
          OR embedding_work_claims.source_hash IS DISTINCT FROM EXCLUDED.source_hash
          OR embedding_work_claims.embedding_profile IS DISTINCT FROM EXCLUDED.embedding_profile
        )
      )
    RETURNING id
  `
  if (acquired[0]) return { state: 'acquired', claimId: acquired[0].id }

  const current = (await db.embeddingWorkClaim.findFirst({
    where: {
      tenantId: params.tenantId,
      venueId: params.venueId,
      entityType: params.entityType,
      entityId: params.entityId,
    },
    select: {
      id: true,
      status: true,
      contentUpdatedAt: true,
      sourceHash: true,
      embeddingProfile: true,
    },
  })) as ClaimRow | null
  if (
    current?.status === 'COMPLETE' &&
    current.contentUpdatedAt.getTime() === params.contentUpdatedAt.getTime() &&
    current.sourceHash === params.sourceHash &&
    current.embeddingProfile === params.embeddingProfile
  ) {
    return { state: 'complete' }
  }
  return { state: 'leased' }
}

export async function releaseEmbeddingWork(params: {
  claimId: string
  tenantId: string
  venueId: string
  leaseToken: string
}): Promise<boolean> {
  const released = await db.embeddingWorkClaim.deleteMany({
    where: {
      id: params.claimId,
      tenantId: params.tenantId,
      venueId: params.venueId,
      status: 'RUNNING',
      leaseToken: params.leaseToken,
    },
  })
  return released.count === 1
}
