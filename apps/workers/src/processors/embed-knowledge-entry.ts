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
import { UnrecoverableError } from 'bullmq'

import { createWorkerAiUsageSink } from '../lib/ai-usage'
import { embeddingRevisionMatches, parseEmbeddingRevision } from '../lib/embedding-revision'

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
    const contentUpdatedAt = parseEmbeddingRevision(payload.contentUpdatedAt)
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
          isEnabled: true,
          updatedAt: true,
        },
      }),
    )

    if (!entry) {
      throw new UnrecoverableError(`VenueKnowledgeEntry ${payload.entryId} not found`)
    }

    if (!entry.isEnabled) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      logger.info({
        action: 'workers.embed-knowledge-entry.skipped-disabled',
        tenantId: payload.tenantId,
        entryId: payload.entryId,
      })
      return
    }

    if (!embeddingRevisionMatches(entry.updatedAt, contentUpdatedAt)) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      logger.info({
        action: 'workers.embed-knowledge-entry.skipped-stale',
        tenantId: payload.tenantId,
        entryId: payload.entryId,
        contentUpdatedAt: payload.contentUpdatedAt,
        currentUpdatedAt: entry.updatedAt.toISOString(),
      })
      return
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
    const stored = await storeKnowledgeEntryEmbeddingForScope({
      entryId: entry.id,
      tenantId: payload.tenantId,
      venueId: entry.venueId,
      contentUpdatedAt,
      source: {
        title: entry.title,
        category: entry.category,
        content: entry.content,
        isEnabled: entry.isEnabled,
      },
      embedding: result.embedding,
    })
    if (!stored) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      logger.info({
        action: 'workers.embed-knowledge-entry.skipped-stale-write',
        tenantId: payload.tenantId,
        entryId: payload.entryId,
        contentUpdatedAt: payload.contentUpdatedAt,
      })
      return
    }
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
