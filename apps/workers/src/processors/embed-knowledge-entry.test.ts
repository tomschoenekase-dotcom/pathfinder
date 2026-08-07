import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  aiUsageCreate: vi.fn(),
  buildKnowledgeEntryText: vi.fn(),
  entryFindFirst: vi.fn(),
  generateEmbedding: vi.fn(),
  storeKnowledgeEntryEmbeddingForScope: vi.fn(),
  updateJobRecord: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
  writeJobRecord: vi.fn(),
}))

vi.mock('@pathfinder/ai', () => ({
  AI_EMBEDDING_MODEL_KEYS: { KNOWLEDGE_CONTENT: 'knowledge-content-embedding' },
  generateEmbedding: mocks.generateEmbedding,
}))
vi.mock('@pathfinder/config', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  buildKnowledgeEntryText: mocks.buildKnowledgeEntryText,
  db: {
    aiUsageEvent: { create: mocks.aiUsageCreate },
    venueKnowledgeEntry: { findFirst: mocks.entryFindFirst },
  },
  storeKnowledgeEntryEmbeddingForScope: mocks.storeKnowledgeEntryEmbeddingForScope,
  updateJobRecord: mocks.updateJobRecord,
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
}))

import { processEmbedKnowledgeEntryJob } from './embed-knowledge-entry'

const entry = {
  id: 'entry_1',
  venueId: 'venue_1',
  title: 'Accessibility',
  category: 'services',
  content: 'Elevators are beside the east entrance.',
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
    mocks.buildKnowledgeEntryText.mockReturnValue('canonical knowledge text')
    mocks.storeKnowledgeEntryEmbeddingForScope.mockResolvedValue(undefined)
    mocks.generateEmbedding.mockImplementation(async (params) => {
      await params.usageSink(usage)
      return { ...usage, embeddings: [[0.2]], embedding: [0.2] }
    })
  })

  it('binds tenant and venue, records usage, and stores the validated embedding', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(entry)
    await processEmbedKnowledgeEntryJob({ tenantId: 'tenant_1', entryId: 'entry_1' }, 'bull_1')
    expect(mocks.entryFindFirst).toHaveBeenCalledWith({
      where: { id: 'entry_1', tenantId: 'tenant_1', venue: { tenantId: 'tenant_1' } },
      select: { id: true, venueId: true, title: true, category: true, content: true },
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
      embedding: [0.2],
    })
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('fails closed without provider, usage, or storage when the scoped entity is absent', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(null)
    await expect(
      processEmbedKnowledgeEntryJob({ tenantId: 'wrong_tenant', entryId: 'entry_1' }),
    ).rejects.toThrow('VenueKnowledgeEntry entry_1 not found')
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.aiUsageCreate).not.toHaveBeenCalled()
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'VenueKnowledgeEntry entry_1 not found',
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
    await expect(
      processEmbedKnowledgeEntryJob({ tenantId: 'tenant_1', entryId: 'entry_1' }),
    ).rejects.toThrow('OpenAI embedding request failed')
    expect(mocks.generateEmbedding).toHaveBeenCalledTimes(1)
    expect(mocks.aiUsageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attempts: 1,
        success: false,
        errorCode: 'provider-http-503',
      }),
    })
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).not.toHaveBeenCalled()
  })

  it('retains observed billed usage but stores nothing for malformed provider data', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(entry)
    mocks.generateEmbedding.mockImplementationOnce(async (params) => {
      await params.usageSink({ ...usage, success: false, errorCode: 'invalid-provider-response' })
      throw new Error('OpenAI returned invalid embedding data')
    })
    await expect(
      processEmbedKnowledgeEntryJob({ tenantId: 'tenant_1', entryId: 'entry_1' }),
    ).rejects.toThrow()
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
    await expect(
      processEmbedKnowledgeEntryJob({ tenantId: 'tenant_1', entryId: 'entry_1' }),
    ).resolves.toBeUndefined()
    expect(mocks.storeKnowledgeEntryEmbeddingForScope).toHaveBeenCalledOnce()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('retains successful provider usage but fails the job when scoped storage fails', async () => {
    mocks.entryFindFirst.mockResolvedValueOnce(entry)
    mocks.storeKnowledgeEntryEmbeddingForScope.mockRejectedValueOnce(new Error('scope changed'))
    await expect(
      processEmbedKnowledgeEntryJob({ tenantId: 'tenant_1', entryId: 'entry_1' }),
    ).rejects.toThrow('scope changed')
    expect(mocks.aiUsageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ success: true }),
    })
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'scope changed',
    })
  })
})
