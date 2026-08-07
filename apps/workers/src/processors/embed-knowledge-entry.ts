import { logger } from '@pathfinder/config'
import { AI_EMBEDDING_MODEL_KEYS, generateEmbedding } from '@pathfinder/ai'
import {
  buildKnowledgeEntryText,
  db,
  storeKnowledgeEntryEmbeddingForScope,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import type { EmbedKnowledgeEntryJobPayload } from '@pathfinder/jobs'

import { createWorkerAiUsageSink } from '../lib/ai-usage'

export async function processEmbedKnowledgeEntryJob(
  payload: EmbedKnowledgeEntryJobPayload,
  bullJobId?: string | null,
): Promise<void> {
  const startedAt = new Date()
  const jobRecordId = await writeJobRecord({
    queue: 'embed-knowledge-entry',
    jobName: 'embed-knowledge-entry-process',
    bullJobId: bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
  })

  try {
    const entry = await withTenantIsolationBypass(async () =>
      db.venueKnowledgeEntry.findFirst({
        where: {
          id: payload.entryId,
          tenantId: payload.tenantId,
          venue: { tenantId: payload.tenantId },
        },
        select: {
          id: true,
          venueId: true,
          title: true,
          category: true,
          content: true,
        },
      }),
    )

    if (!entry) {
      throw new Error(`VenueKnowledgeEntry ${payload.entryId} not found`)
    }

    const result = await generateEmbedding({
      modelKey: AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT,
      text: buildKnowledgeEntryText(entry),
      usageSink: createWorkerAiUsageSink({
        tenantId: payload.tenantId,
        venueId: entry.venueId,
        feature: 'knowledge-entry-embedding',
      }),
    })
    await storeKnowledgeEntryEmbeddingForScope({
      entryId: entry.id,
      tenantId: payload.tenantId,
      venueId: entry.venueId,
      embedding: result.embedding,
    })
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.embed-knowledge-entry.completed',
      tenantId: payload.tenantId,
      entryId: payload.entryId,
    })
  } catch (error) {
    await updateJobRecord(jobRecordId, {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Unknown embed knowledge entry error',
    })

    logger.error({
      action: 'workers.embed-knowledge-entry.failed',
      tenantId: payload.tenantId,
      entryId: payload.entryId,
      error: error instanceof Error ? error.message : 'Unknown embed knowledge entry error',
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })

    throw error
  }
}
