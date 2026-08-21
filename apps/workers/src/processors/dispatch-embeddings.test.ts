import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  acknowledgeEmbeddingDispatch: vi.fn(),
  enqueueEmbedKnowledgeEntry: vi.fn(),
  enqueueEmbedCompanyKnowledge: vi.fn(),
  enqueueEmbedPlace: vi.fn(),
  failEmbeddingDispatch: vi.fn(),
  leaseEmbeddingDispatchBatch: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  acknowledgeEmbeddingDispatch: mocks.acknowledgeEmbeddingDispatch,
  failEmbeddingDispatch: mocks.failEmbeddingDispatch,
  leaseEmbeddingDispatchBatch: mocks.leaseEmbeddingDispatchBatch,
}))
vi.mock('@pathfinder/jobs', () => ({
  enqueueEmbedCompanyKnowledge: mocks.enqueueEmbedCompanyKnowledge,
  enqueueEmbedKnowledgeEntry: mocks.enqueueEmbedKnowledgeEntry,
  enqueueEmbedPlace: mocks.enqueueEmbedPlace,
}))

import { processEmbeddingDispatches } from './dispatch-embeddings'

const revision = new Date('2026-08-07T22:30:00.123Z')
const placeDispatch = {
  id: 'place:place_1',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  entityType: 'PLACE',
  entityId: 'place_1',
  contentUpdatedAt: revision,
}
const knowledgeDispatch = {
  id: 'knowledge:entry_1',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  entityType: 'KNOWLEDGE_ENTRY',
  entityId: 'entry_1',
  contentUpdatedAt: revision,
}
const companyKnowledgeDispatch = {
  id: 'company-knowledge:item_1',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  entityType: 'COMPANY_KNOWLEDGE',
  entityId: 'item_1',
  contentUpdatedAt: revision,
}

describe('processEmbeddingDispatches', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.leaseEmbeddingDispatchBatch.mockResolvedValue({
      leaseToken: 'lease_1',
      dispatches: [],
    })
    mocks.acknowledgeEmbeddingDispatch.mockResolvedValue(true)
    mocks.failEmbeddingDispatch.mockResolvedValue(true)
    mocks.enqueueEmbedPlace.mockResolvedValue(undefined)
    mocks.enqueueEmbedKnowledgeEntry.mockResolvedValue(undefined)
    mocks.enqueueEmbedCompanyKnowledge.mockResolvedValue(undefined)
  })

  it('dispatches all supported entity types and acknowledges exact revisions', async () => {
    mocks.leaseEmbeddingDispatchBatch.mockResolvedValueOnce({
      leaseToken: 'lease_1',
      dispatches: [placeDispatch, knowledgeDispatch, companyKnowledgeDispatch],
    })

    await expect(processEmbeddingDispatches()).resolves.toEqual({
      acknowledged: 3,
      failed: 0,
      superseded: 0,
    })
    expect(mocks.enqueueEmbedPlace).toHaveBeenCalledWith({
      placeId: 'place_1',
      tenantId: 'tenant_1',
      contentUpdatedAt: revision.toISOString(),
    })
    expect(mocks.enqueueEmbedKnowledgeEntry).toHaveBeenCalledWith({
      entryId: 'entry_1',
      tenantId: 'tenant_1',
      contentUpdatedAt: revision.toISOString(),
    })
    expect(mocks.enqueueEmbedCompanyKnowledge).toHaveBeenCalledWith({
      itemId: 'item_1',
      tenantId: 'tenant_1',
      contentUpdatedAt: revision.toISOString(),
    })
    expect(mocks.acknowledgeEmbeddingDispatch).toHaveBeenCalledTimes(3)
  })

  it('retains and schedules a failed enqueue without acknowledging it', async () => {
    mocks.leaseEmbeddingDispatchBatch.mockResolvedValueOnce({
      leaseToken: 'lease_1',
      dispatches: [placeDispatch],
    })
    mocks.enqueueEmbedPlace.mockRejectedValueOnce(new Error('redis unavailable'))

    await expect(processEmbeddingDispatches()).resolves.toEqual({
      acknowledged: 0,
      failed: 1,
      superseded: 0,
    })
    expect(mocks.acknowledgeEmbeddingDispatch).not.toHaveBeenCalled()
    expect(mocks.failEmbeddingDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'place:place_1',
        contentUpdatedAt: revision,
        leaseToken: 'lease_1',
        error: 'redis unavailable',
      }),
    )
  })

  it('does not acknowledge over a newer revision', async () => {
    mocks.leaseEmbeddingDispatchBatch.mockResolvedValueOnce({
      leaseToken: 'lease_1',
      dispatches: [placeDispatch],
    })
    mocks.acknowledgeEmbeddingDispatch.mockResolvedValueOnce(false)

    await expect(processEmbeddingDispatches()).resolves.toEqual({
      acknowledged: 0,
      failed: 0,
      superseded: 1,
    })
  })
})
