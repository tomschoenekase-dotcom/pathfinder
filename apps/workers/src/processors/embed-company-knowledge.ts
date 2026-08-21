import { randomUUID } from 'node:crypto'

import { AI_EMBEDDING_MODEL_KEYS, generateEmbedding, getAiEmbeddingProfile } from '@pathfinder/ai'
import { logger } from '@pathfinder/config'
import {
  acquireEmbeddingWork,
  assertVenueAiAvailable,
  buildCompanyKnowledgeText,
  db,
  embeddingSourceHash,
  isAiAdmissionControlError,
  releaseEmbeddingWork,
  storeCompanyKnowledgeEmbeddingForScope,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import {
  EMBED_COMPANY_KNOWLEDGE_PROCESS_JOB,
  EMBED_KNOWLEDGE_ENTRY_QUEUE,
  type EmbedCompanyKnowledgeJobPayload,
} from '@pathfinder/jobs'
import { UnrecoverableError } from 'bullmq'

import { createWorkerAiBudgetGate, createWorkerAiUsageSink } from '../lib/ai-usage'
import { embeddingRevisionMatches, parseEmbeddingRevision } from '../lib/embedding-revision'
import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  type JobExecutionInput,
} from '../lib/job-execution'

export async function processEmbedCompanyKnowledgeJob(
  payload: EmbedCompanyKnowledgeJobPayload,
  executionInput?: JobExecutionInput,
): Promise<void> {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const jobRecordId = await writeJobRecord({
    queue: EMBED_KNOWLEDGE_ENTRY_QUEUE,
    jobName: EMBED_COMPANY_KNOWLEDGE_PROCESS_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload,
    startedAt: new Date(),
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })
  let claim: { claimId: string; leaseToken: string; venueId: string } | undefined
  try {
    const contentUpdatedAt = parseEmbeddingRevision(payload.contentUpdatedAt)
    const item = await withTenantIsolationBypass(async () =>
      db.companyKnowledgeItem.findFirst({
        where: {
          id: payload.itemId,
          tenantId: payload.tenantId,
          venueId: { not: null },
          promotionStatus: 'PROMOTED',
          archivedAt: null,
        },
        select: {
          id: true,
          tenantId: true,
          venueId: true,
          type: true,
          authority: true,
          title: true,
          summary: true,
          contentHash: true,
          updatedAt: true,
          revisions: {
            orderBy: { revision: 'desc' },
            take: 1,
            select: { body: true },
          },
        },
      }),
    )
    if (!item?.tenantId || !item.venueId) {
      throw new UnrecoverableError(`Venue-scoped CompanyKnowledgeItem ${payload.itemId} not found`)
    }
    if (!embeddingRevisionMatches(item.updatedAt, contentUpdatedAt)) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return
    }
    const text = buildCompanyKnowledgeText({
      title: item.title,
      summary: item.summary,
      type: item.type,
      authority: item.authority,
      body: item.revisions[0]?.body ?? '',
    })
    const sourceHash = embeddingSourceHash('company-knowledge', text)
    const embeddingProfile = getAiEmbeddingProfile(AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT)
    const leaseToken = randomUUID()
    const acquisition = await acquireEmbeddingWork({
      tenantId: item.tenantId,
      venueId: item.venueId,
      entityType: 'COMPANY_KNOWLEDGE',
      entityId: item.id,
      contentUpdatedAt,
      sourceHash,
      embeddingProfile,
      leaseToken,
    })
    if (acquisition.state === 'complete') {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return
    }
    if (acquisition.state === 'leased') throw new Error('Identical embedding work is leased')
    claim = { claimId: acquisition.claimId, leaseToken, venueId: item.venueId }
    const result = await generateEmbedding({
      admissionGuard: () =>
        assertVenueAiAvailable(db, { tenantId: item.tenantId!, venueId: item.venueId! }),
      modelKey: AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT,
      text,
      usageSink: createWorkerAiUsageSink({
        tenantId: item.tenantId,
        venueId: item.venueId,
        feature: 'company-knowledge-embedding',
      }),
      budgetGate: createWorkerAiBudgetGate({
        tenantId: item.tenantId,
        venueId: item.venueId,
        feature: 'company-knowledge-embedding',
      }),
    })
    const storage = await storeCompanyKnowledgeEmbeddingForScope({
      itemId: item.id,
      tenantId: item.tenantId,
      venueId: item.venueId,
      contentUpdatedAt,
      contentHash: item.contentHash,
      embeddingProfile,
      sourceHash,
      embedding: result.embedding,
      claimId: claim.claimId,
      leaseToken: claim.leaseToken,
    })
    if (!storage.claimCompleted) throw new Error('Embedding claim lost ownership or expired')
    claim = undefined
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
    logger.info({
      action: storage.stored
        ? 'workers.embed-company-knowledge.completed'
        : 'workers.embed-company-knowledge.skipped-stale-write',
      tenantId: payload.tenantId,
      itemId: payload.itemId,
    })
  } catch (error) {
    if (claim) {
      try {
        await releaseEmbeddingWork({ ...claim, tenantId: payload.tenantId })
      } catch (releaseError) {
        logger.warn({
          action: 'workers.embed-company-knowledge.claim-release-failed',
          tenantId: payload.tenantId,
          itemId: payload.itemId,
          error: releaseError instanceof Error ? releaseError.message : 'Unknown release error',
        })
      }
    }
    if (isAiAdmissionControlError(error)) throw error
    await recordJobFailure({
      jobRecordId,
      error,
      errorMessage:
        error instanceof Error ? error.message : 'Unknown Company Knowledge embed error',
      execution,
    })
    throw error
  }
}
