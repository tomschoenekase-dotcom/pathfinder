import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  acquire: vi.fn(),
  generate: vi.fn(),
  store: vi.fn(),
  writeJob: vi.fn(),
  updateJob: vi.fn(),
  release: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/ai', () => ({
  AI_EMBEDDING_MODEL_KEYS: { KNOWLEDGE_CONTENT: 'knowledge-content' },
  getAiEmbeddingProfile: vi.fn(() => 'openai:text-embedding-3-small:1536'),
  generateEmbedding: mocks.generate,
}))
vi.mock('@pathfinder/jobs', () => ({
  EMBED_COMPANY_KNOWLEDGE_PROCESS_JOB: 'embed-company-knowledge-process',
  EMBED_KNOWLEDGE_ENTRY_QUEUE: 'test:embed-knowledge-entry',
}))
vi.mock('@pathfinder/db', () => ({
  db: { companyKnowledgeItem: { findFirst: mocks.findFirst } },
  withTenantIsolationBypass: (callback: () => unknown) => callback(),
  acquireEmbeddingWork: mocks.acquire,
  assertVenueAiAvailable: vi.fn(),
  buildCompanyKnowledgeText: vi.fn(() => 'canonical company knowledge'),
  embeddingSourceHash: vi.fn(() => 'a'.repeat(64)),
  isAiAdmissionControlError: vi.fn(() => false),
  releaseEmbeddingWork: mocks.release,
  storeCompanyKnowledgeEmbeddingForScope: mocks.store,
  writeJobRecord: mocks.writeJob,
  updateJobRecord: mocks.updateJob,
}))
vi.mock('../lib/ai-usage', () => ({
  createWorkerAiBudgetGate: vi.fn(() => ({})),
  createWorkerAiUsageSink: vi.fn(() => vi.fn()),
}))
vi.mock('../lib/job-execution', () => ({
  normalizeJobExecutionMetadata: vi.fn(() => ({
    bullJobId: 'job-1',
    attemptNumber: 1,
    maxAttempts: 3,
  })),
  recordJobFailure: vi.fn(),
}))

import { processEmbedCompanyKnowledgeJob } from './embed-company-knowledge'

const revision = new Date('2030-01-01T00:00:00.000Z')
const payload = {
  itemId: 'item-1',
  tenantId: 'tenant-1',
  contentUpdatedAt: revision.toISOString(),
}

describe('Company Knowledge embedding worker', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.writeJob.mockResolvedValue('job-record-1')
    mocks.findFirst.mockResolvedValue({
      id: 'item-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      type: 'DECISION',
      authority: 'AUTHORITATIVE_CURRENT',
      title: 'Pricing policy',
      summary: 'Current pricing rule.',
      contentHash: 'b'.repeat(64),
      updatedAt: revision,
      revisions: [{ body: 'Early customer pricing remains active.' }],
    })
    mocks.acquire.mockResolvedValue({ state: 'acquired', claimId: 'claim-1' })
    mocks.generate.mockResolvedValue({ embedding: [0.1, 0.2] })
    mocks.store.mockResolvedValue({ claimCompleted: true, stored: true })
  })

  it('reuses fenced claims, provider routing, and budgeted storage', async () => {
    await processEmbedCompanyKnowledgeJob(payload)
    expect(mocks.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'COMPANY_KNOWLEDGE',
        entityId: 'item-1',
        venueId: 'venue-1',
      }),
    )
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        modelKey: 'knowledge-content',
        text: 'canonical company knowledge',
      }),
    )
    expect(mocks.store).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'item-1', claimId: 'claim-1' }),
    )
    expect(mocks.updateJob).toHaveBeenCalledWith('job-record-1', { status: 'COMPLETE' })
  })

  it('skips stale dispatches without a provider call', async () => {
    mocks.findFirst.mockResolvedValueOnce({
      ...(await mocks.findFirst()),
      updatedAt: new Date('2030-01-02T00:00:00.000Z'),
    })
    await processEmbedCompanyKnowledgeJob(payload)
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.updateJob).toHaveBeenCalledWith('job-record-1', { status: 'COMPLETE' })
  })
})
