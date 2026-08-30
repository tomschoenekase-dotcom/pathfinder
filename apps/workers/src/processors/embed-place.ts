import { randomUUID } from 'node:crypto'

import { logger } from '@pathfinder/config'
import { AI_EMBEDDING_MODEL_KEYS, generateEmbedding, getAiEmbeddingProfile } from '@pathfinder/ai'
import {
  buildPlaceText,
  embeddingSourceHash,
  acquireEmbeddingWork,
  assertVenueAiAvailable,
  db,
  isAiAdmissionControlError,
  storePlaceEmbeddingForScope,
  releaseEmbeddingWork,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import {
  EMBED_PLACE_PROCESS_JOB,
  EMBED_PLACE_QUEUE,
  type EmbedPlaceJobPayload,
} from '@pathfinder/jobs'
import { UnrecoverableError } from 'bullmq'

import { createWorkerAiBudgetGate, createWorkerAiUsageSink } from '../lib/ai-usage'
import { embeddingRevisionMatches, parseEmbeddingRevision } from '../lib/embedding-revision'
import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  type JobExecutionInput,
} from '../lib/job-execution'

export async function processEmbedPlaceJob(
  payload: EmbedPlaceJobPayload,
  executionInput?: JobExecutionInput,
): Promise<void> {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const startedAt = new Date()
  const jobRecordId = await writeJobRecord({
    queue: EMBED_PLACE_QUEUE,
    jobName: EMBED_PLACE_PROCESS_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })
  let claim: { claimId: string; leaseToken: string; venueId: string } | undefined

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

    const text = buildPlaceText(place)
    const leaseToken = randomUUID()
    const acquisition = await acquireEmbeddingWork({
      tenantId: payload.tenantId,
      venueId: place.venueId,
      entityType: 'PLACE',
      entityId: place.id,
      contentUpdatedAt,
      sourceHash: embeddingSourceHash('place', text),
      embeddingProfile: getAiEmbeddingProfile(AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT),
      leaseToken,
    })
    if (acquisition.state === 'complete') {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      logger.info({
        action: `workers.embed-place.skipped-${acquisition.state}`,
        tenantId: payload.tenantId,
        placeId: payload.placeId,
      })
      return
    }
    if (acquisition.state === 'leased') {
      throw new Error('Identical embedding work is currently leased')
    }
    claim = { claimId: acquisition.claimId, leaseToken, venueId: place.venueId }

    const result = await generateEmbedding({
      admissionGuard: () =>
        assertVenueAiAvailable(db, {
          tenantId: payload.tenantId,
          venueId: place.venueId,
        }),
      modelKey: AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT,
      text,
      usageSink: createWorkerAiUsageSink({
        tenantId: payload.tenantId,
        venueId: place.venueId,
        feature: 'place-embedding',
      }),
      budgetGate: createWorkerAiBudgetGate({
        tenantId: payload.tenantId,
        venueId: place.venueId,
        feature: 'place-embedding',
      }),
    })
    const storage = await storePlaceEmbeddingForScope({
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
      claimId: claim.claimId,
      leaseToken: claim.leaseToken,
    })
    if (!storage.claimCompleted) {
      throw new Error('Embedding work claim completion lost ownership or expired')
    }
    claim = undefined
    if (!storage.stored) {
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
    if (claim) {
      try {
        await releaseEmbeddingWork({ ...claim, tenantId: payload.tenantId })
      } catch (releaseError) {
        logger.warn({
          action: 'workers.embed-place.claim-release-failed',
          tenantId: payload.tenantId,
          placeId: payload.placeId,
          error:
            releaseError instanceof Error ? releaseError.message : 'Unknown claim release error',
        })
      }
    }
    if (isAiAdmissionControlError(error)) throw error
    await recordJobFailure({
      jobRecordId,
      error,
      execution,
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
