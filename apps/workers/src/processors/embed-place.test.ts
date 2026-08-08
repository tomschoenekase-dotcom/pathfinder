import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnrecoverableError } from 'bullmq'

const mocks = vi.hoisted(() => ({
  acquireEmbeddingWork: vi.fn(),
  aiUsageCreate: vi.fn(),
  buildPlaceText: vi.fn(),
  generateEmbedding: vi.fn(),
  placeFindFirst: vi.fn(),
  releaseEmbeddingWork: vi.fn(),
  storePlaceEmbeddingForScope: vi.fn(),
  updateJobRecord: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
  writeJobRecord: vi.fn(),
}))

vi.mock('@pathfinder/ai', () => ({
  AI_EMBEDDING_MODEL_KEYS: { PLACE_CONTENT: 'place-content-embedding' },
  generateEmbedding: mocks.generateEmbedding,
  getAiEmbeddingProfile: vi.fn(() => 'openai:text-embedding-3-small:1536'),
}))

vi.mock('@pathfinder/config', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@pathfinder/db', () => ({
  acquireEmbeddingWork: mocks.acquireEmbeddingWork,
  buildPlaceText: mocks.buildPlaceText,
  embeddingSourceHash: vi.fn(() => 'a'.repeat(64)),
  db: {
    aiUsageEvent: { create: mocks.aiUsageCreate },
    place: { findFirst: mocks.placeFindFirst },
  },
  storePlaceEmbeddingForScope: mocks.storePlaceEmbeddingForScope,
  releaseEmbeddingWork: mocks.releaseEmbeddingWork,
  updateJobRecord: mocks.updateJobRecord,
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
}))

import { processEmbedPlaceJob } from './embed-place'

const contentUpdatedAt = new Date('2026-08-07T18:00:00.123Z')
const payload = {
  tenantId: 'tenant_1',
  placeId: 'place_1',
  contentUpdatedAt: contentUpdatedAt.toISOString(),
}
const place = {
  id: 'place_1',
  venueId: 'venue_1',
  name: 'Main Hall',
  type: 'exhibit',
  itemType: null,
  shortDescription: 'A short description',
  longDescription: null,
  tags: ['art'],
  areaName: 'First Floor',
  hours: null,
  isActive: true,
  updatedAt: contentUpdatedAt,
}

const usage = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  pricingVersion: 'openai-public-2026-08-07',
  usage: { inputTokens: 7, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  estimatedCostUsd: 0.00000014,
  latencyMs: 4,
  attempts: 1,
  success: true,
}

describe('processEmbedPlaceJob', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.withTenantIsolationBypass.mockImplementation((fn: () => unknown) => fn())
    mocks.writeJobRecord.mockResolvedValue('job_record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.aiUsageCreate.mockResolvedValue({ id: 'usage_1' })
    mocks.acquireEmbeddingWork.mockResolvedValue({ state: 'acquired', claimId: 'claim_1' })
    mocks.buildPlaceText.mockReturnValue('canonical place text')
    mocks.releaseEmbeddingWork.mockResolvedValue(true)
    mocks.storePlaceEmbeddingForScope.mockResolvedValue({ claimCompleted: true, stored: true })
    mocks.generateEmbedding.mockImplementation(async (params) => {
      await params.usageSink(usage)
      return { ...usage, embeddings: [[0.1]], embedding: [0.1] }
    })
  })

  it('binds tenant and venue, records usage, and stores the validated embedding', async () => {
    mocks.placeFindFirst.mockResolvedValueOnce(place)

    await processEmbedPlaceJob(payload, 'bull_1')

    expect(mocks.placeFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'place_1',
        tenantId: 'tenant_1',
        venue: { tenantId: 'tenant_1' },
      },
      select: expect.objectContaining({ id: true, venueId: true }),
    })
    expect(mocks.buildPlaceText).toHaveBeenCalledWith(place)
    expect(mocks.generateEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({
        modelKey: 'place-content-embedding',
        text: 'canonical place text',
      }),
    )
    expect(mocks.aiUsageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        feature: 'place-embedding',
        surface: 'worker',
        attempts: 1,
        success: true,
      }),
    })
    expect(mocks.storePlaceEmbeddingForScope).toHaveBeenCalledWith({
      placeId: 'place_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
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
      embedding: [0.1],
      claimId: 'claim_1',
      leaseToken: expect.stringMatching(/^[a-f0-9-]{36}$/),
    })
    expect(mocks.acquireEmbeddingWork).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        entityType: 'PLACE',
        entityId: 'place_1',
        contentUpdatedAt,
        leaseToken: expect.stringMatching(/^[a-f0-9-]{36}$/),
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        embeddingProfile: 'openai:text-embedding-3-small:1536',
      }),
    )
    expect(mocks.storePlaceEmbeddingForScope).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: 'claim_1',
        leaseToken: expect.stringMatching(/^[a-f0-9-]{36}$/),
      }),
    )
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('fails closed without provider, usage, or storage when the scoped entity is absent', async () => {
    mocks.placeFindFirst.mockResolvedValueOnce(null)
    await expect(processEmbedPlaceJob({ ...payload, tenantId: 'wrong_tenant' })).rejects.toThrow(
      'Place place_1 not found',
    )
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.aiUsageCreate).not.toHaveBeenCalled()
    expect(mocks.storePlaceEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'Place place_1 not found',
      attemptNumber: 1,
      maxAttempts: 1,
      failureDisposition: 'UNRECOVERABLE',
    })
  })

  it('completes without provider work when the scoped place is inactive', async () => {
    mocks.placeFindFirst.mockResolvedValueOnce({ ...place, isActive: false })

    await expect(processEmbedPlaceJob(payload)).resolves.toBeUndefined()
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.aiUsageCreate).not.toHaveBeenCalled()
    expect(mocks.storePlaceEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })

  it('fails a malformed revision as unrecoverable before entity or provider work', async () => {
    mocks.updateJobRecord.mockRejectedValueOnce(new Error('job record database unavailable'))

    await expect(
      processEmbedPlaceJob({ ...payload, contentUpdatedAt: 'legacy-missing-revision' }),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(mocks.placeFindFirst).not.toHaveBeenCalled()
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.storePlaceEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'Embedding contentUpdatedAt must be an ISO UTC timestamp',
      attemptNumber: 1,
      maxAttempts: 1,
      failureDisposition: 'UNRECOVERABLE',
    })
  })

  it('makes one gateway call and records one failed attempt for a retryable provider error', async () => {
    mocks.placeFindFirst.mockResolvedValueOnce(place)
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
    await expect(processEmbedPlaceJob(payload)).rejects.toThrow('OpenAI embedding request failed')
    expect(mocks.generateEmbedding).toHaveBeenCalledTimes(1)
    expect(mocks.aiUsageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attempts: 1,
        success: false,
        errorCode: 'provider-http-503',
      }),
    })
    expect(mocks.storePlaceEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.releaseEmbeddingWork).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: 'claim_1', tenantId: 'tenant_1' }),
    )
  })

  it('skips provider and storage for a durable successful replay', async () => {
    mocks.placeFindFirst.mockResolvedValueOnce(place)
    mocks.acquireEmbeddingWork.mockResolvedValueOnce({ state: 'complete' })

    await expect(processEmbedPlaceJob(payload, 'bull_duplicate')).resolves.toBeUndefined()
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.storePlaceEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })

  it('retries rather than completing while identical work is leased', async () => {
    mocks.placeFindFirst.mockResolvedValueOnce(place)
    mocks.acquireEmbeddingWork.mockResolvedValueOnce({ state: 'leased' })

    await expect(processEmbedPlaceJob(payload, 'bull_duplicate')).rejects.toThrow(
      'currently leased',
    )
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.storePlaceEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'Identical embedding work is currently leased',
      attemptNumber: 1,
      maxAttempts: 1,
      failureDisposition: 'ATTEMPTS_EXHAUSTED',
    })
  })

  it('uses a fresh fencing token for each processor invocation, independent of Bull job ID', async () => {
    mocks.placeFindFirst.mockResolvedValue(place)

    await processEmbedPlaceJob(payload, 'bull_retry')
    await processEmbedPlaceJob(payload, 'bull_retry')

    const firstToken = mocks.acquireEmbeddingWork.mock.calls[0]?.[0].leaseToken
    const secondToken = mocks.acquireEmbeddingWork.mock.calls[1]?.[0].leaseToken
    expect(firstToken).toMatch(/^[a-f0-9-]{36}$/)
    expect(secondToken).toMatch(/^[a-f0-9-]{36}$/)
    expect(secondToken).not.toBe(firstToken)
  })

  it('retains observed billed usage but stores nothing for a malformed provider response', async () => {
    mocks.placeFindFirst.mockResolvedValueOnce(place)
    mocks.generateEmbedding.mockImplementationOnce(async (params) => {
      await params.usageSink({ ...usage, success: false, errorCode: 'invalid-provider-response' })
      throw new Error('OpenAI returned invalid embedding data')
    })
    await expect(processEmbedPlaceJob(payload)).rejects.toThrow()
    expect(mocks.aiUsageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inputTokens: 7,
        estimatedCostUsd: 0.00000014,
        success: false,
        errorCode: 'invalid-provider-response',
      }),
    })
    expect(mocks.storePlaceEmbeddingForScope).not.toHaveBeenCalled()
  })

  it('stores and completes when usage persistence fails', async () => {
    mocks.placeFindFirst.mockResolvedValueOnce(place)
    mocks.aiUsageCreate.mockRejectedValueOnce(new Error('usage db unavailable'))
    await expect(processEmbedPlaceJob(payload)).resolves.toBeUndefined()
    expect(mocks.storePlaceEmbeddingForScope).toHaveBeenCalledOnce()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('retains successful provider usage but fails the job when scoped storage fails', async () => {
    mocks.placeFindFirst.mockResolvedValueOnce(place)
    mocks.storePlaceEmbeddingForScope.mockRejectedValueOnce(new Error('scope changed'))
    await expect(processEmbedPlaceJob(payload)).rejects.toThrow('scope changed')
    expect(mocks.aiUsageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ success: true }),
    })
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'scope changed',
      attemptNumber: 1,
      maxAttempts: 1,
      failureDisposition: 'ATTEMPTS_EXHAUSTED',
    })
  })

  it('completes stale queued revisions before provider or usage work', async () => {
    mocks.placeFindFirst.mockResolvedValueOnce({
      ...place,
      updatedAt: new Date('2026-08-07T18:00:00.124Z'),
    })

    await expect(processEmbedPlaceJob(payload)).resolves.toBeUndefined()
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
    expect(mocks.aiUsageCreate).not.toHaveBeenCalled()
    expect(mocks.storePlaceEmbeddingForScope).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })

  it('does not overwrite a revision that changes during the provider call', async () => {
    mocks.placeFindFirst.mockResolvedValueOnce(place)
    mocks.storePlaceEmbeddingForScope.mockResolvedValueOnce({
      claimCompleted: true,
      stored: false,
    })

    await expect(processEmbedPlaceJob(payload)).resolves.toBeUndefined()
    expect(mocks.generateEmbedding).toHaveBeenCalledOnce()
    expect(mocks.storePlaceEmbeddingForScope).toHaveBeenCalledOnce()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })
})
