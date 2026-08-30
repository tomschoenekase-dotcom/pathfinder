import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnrecoverableError } from 'bullmq'

const mocks = vi.hoisted(() => ({
  acquireEmbeddingWork: vi.fn(),
  aiUsageCreate: vi.fn(),
  buildKnowledgeEntryText: vi.fn(),
  entryFindFirst: vi.fn(),
  generateEmbedding: vi.fn(),
  releaseEmbeddingWork: vi.fn(),
  storeKnowledgeEntryEmbeddingForScope: vi.fn(),
  updateJobRecord: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
  writeJobRecord: vi.fn(),
}))

vi.mock('@pathfinder/ai', () => ({
  AI_EMBEDDING_MODEL_KEYS: { KNOWLEDGE_CONTENT: 'knowledge-content-embedding' },
  generateEmbedding: mocks.generateEmbedding,
  getAiEmbeddingProfile: vi.fn(() => 'openai:text-embedding-3-small:1536'),
}))
vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'staging' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  GlobalAiAdmissionError: class GlobalAiAdmissionError extends Error {
    name = 'GlobalAiAdmissionError'
    constructor(readonly code: string) {
      super('Global AI admission is unavailable')
    }
  },
  isAiAdmissionControlError: (error: unknown) =>
    error instanceof Error &&
    (error.name === 'GlobalAiAdmissionError' ||
      error.name === 'AiCostBudgetExceededError' ||
      error.name === 'AiCostBudgetUnavailableError'),
  acquireEmbeddingWork: mocks.acquireEmbeddingWork,
  buildKnowledgeEntryText: mocks.buildKnowledgeEntryText,
  embeddingSourceHash: vi.fn(() => 'a'.repeat(64)),
  db: {
    aiUsageEvent: { create: mocks.aiUsageCreate },
    venueKnowledgeEntry: { findFirst: mocks.entryFindFirst },
  },
  storeKnowledgeEntryEmbeddingForScope: mocks.storeKnowledgeEntryEmbeddingForScope,
  releaseEmbeddingWork: mocks.releaseEmbeddingWork,
  updateJobRecord: mocks.updateJobRecord,
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
}))

import { processEmbedKnowledgeEntryJob } from './embed-knowledge-entry'
import { GlobalAiAdmissionError } from '@pathfinder/db'

const contentUpdatedAt = new Date('2026-08-07T18:00:00.123Z')
const payload = {
  tenantId: 'tenant_1',
  entryId: 'entry_1',
  contentUpdatedAt: contentUpdatedAt.toISOString(),
}
const entry = {
  id: 'entry_1',
  venueId: 'venue_1',
  title: 'Accessibility',
  category: 'services',
  content: 'Elevators are beside the east entrance.',
  isEnabled: true,
  updatedAt: contentUpdatedAt,
}
const usage = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  pricingVersion: 'openai-public-2026-08-07',
  usage: { inputTokens: 9, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  estimatedCostUsd: 0.00000018,
  latencyMs: 5,
  attempts: 1,
  success: true,
}

describe('processEmbedKnowledgeEntryJob', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.withTenantIsolationBypass.mockImplementation((fn: () => unknown) => fn())
    mocks.writeJobRecord.mockResolvedValue('job_record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.aiUsageCreate.mockResolvedValue({ id: 'usage_1' })
    mocks.acquireEmbeddingWork.mockResolvedValue({ state: 'acquired', claimId: 'claim_1' })
    mocks.buildKnowledgeEntryText.mockReturnValue('canonical knowledge text')
    mocks.releaseEmbeddingWork.mockResolvedValue(true)
    mocks.storeKnowledgeEntryEmbeddingForScope.mockResolvedValue({
      claimCompleted: true,
      stored: true,
    })
    mocks.generateEmbedding.mockImplementation(async (params) => {
      await params.usageSink(usage)
      return { ...usage, embeddings: [[0.2]], embedding: [0.2] }
    })
  })

  it('binds tenant and venue, records usage, and stores the validated embedding', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(entry)
    await processEmbedKnowledgeEntryJob(payload, 'bull_1')
    expect(mocks.entryFindFirst).toHaveBeenCalledWith({
      where: { id: 'entry_1', tenantId: 'tenant_1', venue: { tenantId: 'tenant_1' } },
      select: {
        id: true,
        venueId: true,
        title: true,
        category: true,
        content: true,
        isEnabled: true,
        updatedAt: true,
      },
    })
    expect(mocks.buildKnowledgeEntryText).toHaveBeenCalledWith(entry)
    expect(mocks.generateEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({
        modelKey: 'knowledge-content-embedding',
        text: 'canonical knowledge text',
      }),
    )
    expect(mocks.aiUsageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        feature: 'knowledge-entry-embedding',
        surface: 'worker',
        attempts: 1,
        success: true,
      }),
    })
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).toHaveBeenCalledWith({
      entryId: 'entry_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      contentUpdatedAt,
      source: {
        title: entry.title,
        category: entry.category,
        content: entry.content,
        isEnabled: entry.isEnabled,
      },
      embedding: [0.2],
      claimId: 'claim_1',
      leaseToken: expect.stringMatching(/^[a-f0-9-]{36}$/),
    })
    expect(mocks.acquireEmbeddingWork).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        entityType: 'KNOWLEDGE_ENTRY',
        entityId: 'entry_1',
        contentUpdatedAt,
        leaseToken: expect.stringMatching(/^[a-f0-9-]{36}$/),
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        embeddingProfile: 'openai:text-embedding-3-small:1536',
      }),
    )
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: 'claim_1',
        leaseToken: expect.stringMatching(/^[a-f0-9-]{36}$/),
      }),
    )
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('releases its claim without recording failure when admission pauses', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(entry)
    const pause = new GlobalAiAdmissionError('global-ai-paused')
    mocks.generateEmbedding.mockRejectedValueOnce(pause)

    await expect(processEmbedKnowledgeEntryJob(payload)).rejects.toBe(pause)

    expect(mocks.releaseEmbeddingWork).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: 'claim_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      }),
    )
    expect(mocks.updateJobRecord).not.toHaveBeenCalled()
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).not.toHaveBeenCalled()
  })

  it('fails closed without provider, usage, or storage when the scoped entity is absent', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(null)
    await expect(
      processEmbedKnowledgeEntryJob({ ...payload, tenantId: 'wrong_tenant' }),
    ).rejects.toThrow('VenueKnowledgeEntry entry_1 not found')
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.aiUsageCreate).not.toHaveBeenCalled()
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'JOB_UNRECOVERABLE',
      attemptNumber: 1,
      maxAttempts: 1,
      failureDisposition: 'UNRECOVERABLE',
    })
  })

  it('completes without provider work when the scoped entry is disabled', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce({ ...entry, isEnabled: false })

    await expect(processEmbedKnowledgeEntryJob(payload)).resolves.toBeUndefined()
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.aiUsageCreate).not.toHaveBeenCalled()
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })

  it('fails a malformed revision as unrecoverable before entity or provider work', async () => {
    await expect(
      processEmbedKnowledgeEntryJob({ ...payload, contentUpdatedAt: 'legacy-missing-revision' }),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(mocks.entryFindFirst).not.toHaveBeenCalled()
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'JOB_UNRECOVERABLE',
      attemptNumber: 1,
      maxAttempts: 1,
      failureDisposition: 'UNRECOVERABLE',
    })
  })

  it('makes one gateway call and records one failed attempt for a retryable provider error', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(entry)
    mocks.generateEmbedding.mockImplementationOnce(async (params) => {
      await params.usageSink({
        ...usage,
        usage: { ...usage.usage, inputTokens: 0 },
        estimatedCostUsd: 0,
        success: false,
        errorCode: 'provider-http-503',
      })
      throw new Error('OpenAI embedding request failed')
    })
    await expect(processEmbedKnowledgeEntryJob(payload)).rejects.toThrow(
      'OpenAI embedding request failed',
    )
    expect(mocks.generateEmbedding).toHaveBeenCalledTimes(1)
    expect(mocks.aiUsageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attempts: 1,
        success: false,
        errorCode: 'provider-http-503',
      }),
    })
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.releaseEmbeddingWork).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: 'claim_1', tenantId: 'tenant_1' }),
    )
  })

  it('skips provider and storage for a durable successful replay', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(entry)
    mocks.acquireEmbeddingWork.mockResolvedValueOnce({ state: 'complete' })

    await expect(processEmbedKnowledgeEntryJob(payload, 'bull_duplicate')).resolves.toBeUndefined()
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })

  it('retries rather than completing while identical work is leased', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(entry)
    mocks.acquireEmbeddingWork.mockResolvedValueOnce({ state: 'leased' })

    await expect(processEmbedKnowledgeEntryJob(payload, 'bull_duplicate')).rejects.toThrow(
      'currently leased',
    )
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'JOB_ATTEMPTS_EXHAUSTED',
      attemptNumber: 1,
      maxAttempts: 1,
      failureDisposition: 'ATTEMPTS_EXHAUSTED',
    })
  })

  it('retains observed billed usage but stores nothing for malformed provider data', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(entry)
    mocks.generateEmbedding.mockImplementationOnce(async (params) => {
      await params.usageSink({ ...usage, success: false, errorCode: 'invalid-provider-response' })
      throw new Error('OpenAI returned invalid embedding data')
    })
    await expect(processEmbedKnowledgeEntryJob(payload)).rejects.toThrow()
    expect(mocks.aiUsageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inputTokens: 9,
        estimatedCostUsd: 0.00000018,
        success: false,
        errorCode: 'invalid-provider-response',
      }),
    })
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).not.toHaveBeenCalled()
  })

  it('stores and completes when usage persistence fails', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(entry)
    mocks.aiUsageCreate.mockRejectedValueOnce(new Error('usage db unavailable'))
    await expect(processEmbedKnowledgeEntryJob(payload)).resolves.toBeUndefined()
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).toHaveBeenCalledOnce()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('retains successful provider usage but fails the job when scoped storage fails', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(entry)
    mocks.storeKnowledgeEntryEmbeddingForScope.mockRejectedValueOnce(new Error('scope changed'))
    await expect(processEmbedKnowledgeEntryJob(payload)).rejects.toThrow('scope changed')
    expect(mocks.aiUsageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ success: true }),
    })
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'JOB_ATTEMPTS_EXHAUSTED',
      attemptNumber: 1,
      maxAttempts: 1,
      failureDisposition: 'ATTEMPTS_EXHAUSTED',
    })
  })

  it('completes stale queued revisions before provider or usage work', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce({
      ...entry,
      updatedAt: new Date('2026-08-07T18:00:00.124Z'),
    })

    await expect(processEmbedKnowledgeEntryJob(payload)).resolves.toBeUndefined()
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.aiUsageCreate).not.toHaveBeenCalled()
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })

  it('does not overwrite a revision that changes during the provider call', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(entry)
    mocks.storeKnowledgeEntryEmbeddingForScope.mockResolvedValueOnce({
      claimCompleted: true,
      stored: false,
    })

    await expect(processEmbedKnowledgeEntryJob(payload)).resolves.toBeUndefined()
    expect(mocks.generateEmbedding).toHaveBeenCalledOnce()
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).toHaveBeenCalledOnce()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })
})
