import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeRaw, queryRaw } = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
}))

vi.mock('../client', () => ({
  db: {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
  },
}))

vi.mock('@pathfinder/config/geo', () => ({
  haversineDistanceMeters: vi.fn(() => 0),
}))

import { searchKnowledgeByEmbedding, storeKnowledgeEntryEmbedding } from './semantic-search'

describe('knowledge semantic search helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps raw knowledge rows and coerces distance to number', async () => {
    queryRaw.mockResolvedValueOnce([
      {
        id: 'entry_1',
        title: 'Refund policy',
        category: 'Policy',
        content: 'Refunds are available within 30 days.',
        distance: '0.42',
      },
    ])

    const result = await searchKnowledgeByEmbedding({
      queryEmbedding: [0.1, 0.2],
      venueId: 'venue_1',
      tenantId: 'tenant_1',
      limit: 100,
    })

    expect(result).toEqual([
      {
        id: 'entry_1',
        title: 'Refund policy',
        category: 'Policy',
        content: 'Refunds are available within 30 days.',
        distance: 0.42,
      },
    ])
    expect(queryRaw).toHaveBeenCalledTimes(1)
  })

  it('stores a knowledge entry vector with raw SQL', async () => {
    executeRaw.mockResolvedValueOnce(1)

    await storeKnowledgeEntryEmbedding('entry_1', [0.1, 0.2])

    expect(executeRaw).toHaveBeenCalledTimes(1)
  })
})
