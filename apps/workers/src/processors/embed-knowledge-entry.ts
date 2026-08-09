import { randomUUID } from 'node:crypto'

import { logger } from '@pathfinder/config'
import { AI_EMBEDDING_MODEL_KEYS, generateEmbedding, getAiEmbeddingProfile } from '@pathfinder/ai'
import {
  buildKnowledgeEntryText,
  embeddingSourceHash,
  acquireEmbeddingWork,
  assertGlobalAiAvailable,
  db,
  isAiAdmissionControlError,
  storeKnowledgeEntryEmbeddingForScope,
  releaseEmbeddingWork,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import {
  EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB,
  EMBED_KNOWLEDGE_ENTRY_QUEUE,
  type EmbedKnowledgeEntryJobPayload,
} from '@pathfinder/jobs'
import { UnrecoverableError } from 'bullmq'

import { createWorkerAiBudgetGate, createWorkerAiUsageSink } from '../lib/ai-usage'
import { embeddingRevisionMatches, parseEmbeddingRevision } from '../lib/embedding-revision'
import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  type JobExecutionInput,
} from '../lib/job-execution'

export async function processEmbedKnowledgeEntryJob(
  payload: EmbedKnowledgeEntryJobPayload,
  executionInput?: JobExecutionInput,
): Promise<void> {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const startedAt = new Date()
  const jobRecordId = await writeJobRecord({
    queue: EMBED_KNOWLEDGE_ENTRY_QUEUE,
    jobName: EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB,
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

    const text = buildKnowledgeEntryText(entry)
    const leaseToken = randomUUID()
    const acquisition = await acquireEmbeddingWork({
      tenantId: payload.tenantId,
      venueId: entry.venueId,
      entityType: 'KNOWLEDGE_ENTRY',
      entityId: entry.id,
      contentUpdatedAt,
      sourceHash: embeddingSourceHash('knowledge-entry', text),
      embeddingProfile: getAiEmbeddingProfile(AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT),
      leaseToken,
    })
    if (acquisition.state === 'complete') {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      logger.info({
        action: `workers.embed-knowledge-entry.skipped-${acquisition.state}`,
        tenantId: payload.tenantId,
        entryId: payload.entryId,
      })
      return
    }
    if (acquisition.state === 'leased') {
      throw new Error('Identical embedding work is currently leased')
    }
    claim = { claimId: acquisition.claimId, leaseToken, venueId: entry.venueId }

    const result = await generateEmbedding({
      admissionGuard: () => assertGlobalAiAvailable(db),
      modelKey: AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT,
      text,
      usageSink: createWorkerAiUsageSink({
        tenantId: payload.tenantId,
        venueId: entry.venueId,
        feature: 'knowledge-entry-embedding',
      }),
      budgetGate: createWorkerAiBudgetGate({
        tenantId: payload.tenantId,
        venueId: entry.venueId,
        feature: 'knowledge-entry-embedding',
      }),
    })
    const storage = await storeKnowledgeEntryEmbeddingForScope({
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
    if (claim) {
      try {
        await releaseEmbeddingWork({ ...claim, tenantId: payload.tenantId })
      } catch (releaseError) {
        logger.warn({
          action: 'workers.embed-knowledge-entry.claim-release-failed',
          tenantId: payload.tenantId,
          entryId: payload.entryId,
          error:
            releaseError instanceof Error ? releaseError.message : 'Unknown claim release error',
        })
      }
    }
    if (isAiAdmissionControlError(error)) throw error
    await recordJobFailure({
      jobRecordId,
      error,
      errorMessage: error instanceof Error ? error.message : 'Unknown embed knowledge entry error',
      execution,
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
