import { logger } from '@pathfinder/config'
import {
  acknowledgeEmbeddingDispatch,
  failEmbeddingDispatch,
  leaseEmbeddingDispatchBatch,
} from '@pathfinder/db'
import {
  enqueueEmbedCompanyKnowledge,
  enqueueEmbedKnowledgeEntry,
  enqueueEmbedPlace,
} from '@pathfinder/jobs'

export async function processEmbeddingDispatches(): Promise<{
  acknowledged: number
  failed: number
  superseded: number
}> {
  const { dispatches, leaseToken } = await leaseEmbeddingDispatchBatch()
  let acknowledged = 0
  let failed = 0
  let superseded = 0

  for (const dispatch of dispatches) {
    try {
      if (dispatch.entityType === 'PLACE') {
        await enqueueEmbedPlace({
          placeId: dispatch.entityId,
          tenantId: dispatch.tenantId,
          contentUpdatedAt: dispatch.contentUpdatedAt.toISOString(),
        })
      } else if (dispatch.entityType === 'KNOWLEDGE_ENTRY') {
        await enqueueEmbedKnowledgeEntry({
          entryId: dispatch.entityId,
          tenantId: dispatch.tenantId,
          contentUpdatedAt: dispatch.contentUpdatedAt.toISOString(),
        })
      } else {
        await enqueueEmbedCompanyKnowledge({
          itemId: dispatch.entityId,
          tenantId: dispatch.tenantId,
          contentUpdatedAt: dispatch.contentUpdatedAt.toISOString(),
        })
      }

      const removed = await acknowledgeEmbeddingDispatch({
        id: dispatch.id,
        tenantId: dispatch.tenantId,
        venueId: dispatch.venueId,
        contentUpdatedAt: dispatch.contentUpdatedAt,
        leaseToken,
      })
      if (removed) acknowledged += 1
      else superseded += 1
    } catch (error) {
      failed += 1
      await failEmbeddingDispatch({
        id: dispatch.id,
        tenantId: dispatch.tenantId,
        venueId: dispatch.venueId,
        contentUpdatedAt: dispatch.contentUpdatedAt,
        leaseToken,
        error: error instanceof Error ? error.message : 'Unknown embedding dispatch error',
      })
    }
  }

  logger.info({
    action: 'workers.embedding-dispatch.completed',
    leased: dispatches.length,
    acknowledged,
    failed,
    superseded,
  })
  return { acknowledged, failed, superseded }
}
