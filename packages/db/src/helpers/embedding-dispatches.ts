import { randomUUID } from 'node:crypto'

import type { EmbeddingWorkEntityType } from '@prisma/client'

import { db } from '../client'

export const EMBEDDING_DISPATCH_LEASE_MS = 60_000
export const EMBEDDING_DISPATCH_BATCH_SIZE = 50
export const EMBEDDING_DISPATCH_FAILURE_CODE = 'EMBEDDING_DISPATCH_FAILED'

export type LeasedEmbeddingDispatch = {
  id: string
  tenantId: string
  venueId: string
  entityType: EmbeddingWorkEntityType
  entityId: string
  contentUpdatedAt: Date
}

export async function leaseEmbeddingDispatchBatch(params?: {
  batchSize?: number
  leaseToken?: string
}): Promise<{ leaseToken: string; dispatches: LeasedEmbeddingDispatch[] }> {
  const leaseToken = params?.leaseToken ?? randomUUID()
  const batchSize = Math.max(1, Math.min(500, params?.batchSize ?? EMBEDDING_DISPATCH_BATCH_SIZE))
  const dispatches = await db.$queryRaw<LeasedEmbeddingDispatch[]>`
    WITH candidates AS (
      SELECT id
      FROM embedding_dispatches
      WHERE next_attempt_at <= clock_timestamp()
        AND (lease_token IS NULL OR lease_expires_at <= clock_timestamp())
      ORDER BY next_attempt_at ASC, created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE embedding_dispatches AS dispatch
    SET lease_token = ${leaseToken},
        lease_expires_at = clock_timestamp() + ${EMBEDDING_DISPATCH_LEASE_MS} * INTERVAL '1 millisecond',
        attempts = dispatch.attempts + 1,
        updated_at = clock_timestamp()
    FROM candidates
    WHERE dispatch.id = candidates.id
    RETURNING dispatch.id,
              dispatch.tenant_id AS "tenantId",
              dispatch.venue_id AS "venueId",
              dispatch.entity_type AS "entityType",
              dispatch.entity_id AS "entityId",
              dispatch.content_updated_at AS "contentUpdatedAt"
  `
  return { leaseToken, dispatches }
}

export async function acknowledgeEmbeddingDispatch(params: {
  id: string
  tenantId: string
  venueId: string
  contentUpdatedAt: Date
  leaseToken: string
}): Promise<boolean> {
  const deleted = await db.embeddingDispatch.deleteMany({
    where: {
      id: params.id,
      tenantId: params.tenantId,
      venueId: params.venueId,
      contentUpdatedAt: params.contentUpdatedAt,
      leaseToken: params.leaseToken,
    },
  })
  return deleted.count === 1
}

export async function failEmbeddingDispatch(params: {
  id: string
  tenantId: string
  venueId: string
  contentUpdatedAt: Date
  leaseToken: string
}): Promise<boolean> {
  const failed = await db.$executeRaw`
    UPDATE embedding_dispatches
    SET lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = clock_timestamp()
          + LEAST(300, 5 * POWER(2, GREATEST(attempts - 1, 0))) * INTERVAL '1 second',
        last_error = ${EMBEDDING_DISPATCH_FAILURE_CODE},
        updated_at = clock_timestamp()
    WHERE id = ${params.id}
      AND tenant_id = ${params.tenantId}
      AND venue_id = ${params.venueId}
      AND content_updated_at = ${params.contentUpdatedAt}
      AND lease_token = ${params.leaseToken}
  `
  return failed === 1
}
