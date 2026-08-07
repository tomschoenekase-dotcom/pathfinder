import { logger } from '@pathfinder/config'
import { AI_EMBEDDING_MODEL_KEYS, generateEmbedding } from '@pathfinder/ai'
import {
  buildPlaceText,
  db,
  storePlaceEmbeddingForScope,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import type { EmbedPlaceJobPayload } from '@pathfinder/jobs'
import { UnrecoverableError } from 'bullmq'

import { createWorkerAiUsageSink } from '../lib/ai-usage'
import { embeddingRevisionMatches, parseEmbeddingRevision } from '../lib/embedding-revision'

export async function processEmbedPlaceJob(
  payload: EmbedPlaceJobPayload,
  bullJobId?: string | null,
): Promise<void> {
  const startedAt = new Date()
  const jobRecordId = await writeJobRecord({
    queue: 'embed-place',
    jobName: 'embed-place-process',
    bullJobId: bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
  })

  try {
    const contentUpdatedAt = parseEmbeddingRevision(payload.contentUpdatedAt)
    const place = await withTenantIsolationBypass(async () =>
      db.place.findFirst({
        where: {
          id: payload.placeId,
          tenantId: payload.tenantId,
          venue: { tenantId: payload.tenantId },
        },
        select: {
          id: true,
          venueId: true,
          name: true,
          type: true,
          itemType: true,
          shortDescription: true,
          longDescription: true,
          tags: true,
          areaName: true,
          hours: true,
          isActive: true,
          updatedAt: true,
        },
      }),
    )

    if (!place) {
      throw new UnrecoverableError(`Place ${payload.placeId} not found`)
    }

    if (!place.isActive) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      logger.info({
        action: 'workers.embed-place.skipped-inactive',
        tenantId: payload.tenantId,
        placeId: payload.placeId,
      })
      return
    }

    if (!embeddingRevisionMatches(place.updatedAt, contentUpdatedAt)) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      logger.info({
        action: 'workers.embed-place.skipped-stale',
        tenantId: payload.tenantId,
        placeId: payload.placeId,
        contentUpdatedAt: payload.contentUpdatedAt,
        currentUpdatedAt: place.updatedAt.toISOString(),
      })
      return
    }

    const result = await generateEmbedding({
      modelKey: AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT,
      text: buildPlaceText(place),
      usageSink: createWorkerAiUsageSink({
        tenantId: payload.tenantId,
        venueId: place.venueId,
        feature: 'place-embedding',
      }),
    })
    const stored = await storePlaceEmbeddingForScope({
      placeId: place.id,
      tenantId: payload.tenantId,
      venueId: place.venueId,
      contentUpdatedAt,
      source: {
        name: place.name,
        type: place.type,
        itemType: place.itemType,
        shortDescription: place.shortDescription,
        longDescription: place.longDescription,
        tags: place.tags,
        areaName: place.areaName,
        hours: place.hours,
        isActive: place.isActive,
      },
      embedding: result.embedding,
    })
    if (!stored) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      logger.info({
        action: 'workers.embed-place.skipped-stale-write',
        tenantId: payload.tenantId,
        placeId: payload.placeId,
        contentUpdatedAt: payload.contentUpdatedAt,
      })
      return
    }
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.embed-place.completed',
      tenantId: payload.tenantId,
      placeId: payload.placeId,
    })
  } catch (error) {
    await updateJobRecord(jobRecordId, {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Unknown embed place error',
    })

    logger.error({
      action: 'workers.embed-place.failed',
      tenantId: payload.tenantId,
      placeId: payload.placeId,
      error: error instanceof Error ? error.message : 'Unknown embed place error',
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })

    throw error
  }
}
