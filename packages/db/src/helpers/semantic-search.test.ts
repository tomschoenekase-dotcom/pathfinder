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

import {
  searchKnowledgeByEmbedding,
  storeKnowledgeEntryEmbeddingForScope,
  storePlaceEmbeddingForScope,
} from './semantic-search'

const contentUpdatedAt = new Date('2026-08-07T18:00:00.123Z')
const placeSource = {
  name: 'Main Hall',
  type: 'exhibit',
  itemType: null,
  shortDescription: 'A short description',
  longDescription: null,
  tags: ['art'],
  areaName: 'First Floor',
  hours: null,
  isActive: true,
}
const knowledgeSource = {
  title: 'Refund policy',
  category: 'Policy',
  content: 'Refunds are available within 30 days.',
  isEnabled: true,
}

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

  it('binds place writes to scope, revision, and every captured source field', async () => {
    executeRaw.mockResolvedValueOnce(1)
    await expect(
      storePlaceEmbeddingForScope({
        placeId: 'place_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        contentUpdatedAt,
        source: placeSource,
        embedding: [0.1, 0.2],
      }),
    ).resolves.toBe(true)
    expect(executeRaw.mock.calls[0]?.slice(1)).toEqual([
      '[0.1,0.2]',
      'place_1',
      'tenant_1',
      'venue_1',
      contentUpdatedAt,
      'Main Hall',
      'exhibit',
      null,
      'A short description',
      null,
      ['art'],
      'First Floor',
      null,
      true,
    ])
  })

  it('binds knowledge writes to scope, revision, and every captured source field', async () => {
    executeRaw.mockResolvedValueOnce(1)
    await expect(
      storeKnowledgeEntryEmbeddingForScope({
        entryId: 'entry_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        contentUpdatedAt,
        source: knowledgeSource,
        embedding: [0.3, 0.4],
      }),
    ).resolves.toBe(true)
    expect(executeRaw.mock.calls[0]?.slice(1)).toEqual([
      '[0.3,0.4]',
      'entry_1',
      'tenant_1',
      'venue_1',
      contentUpdatedAt,
      'Refund policy',
      'Policy',
      'Refunds are available within 30 days.',
      true,
    ])
  })

  it('returns false without throwing when scope, revision, or source changed', async () => {
    executeRaw.mockResolvedValueOnce(0)
    await expect(
      storePlaceEmbeddingForScope({
        placeId: 'place_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        contentUpdatedAt,
        source: placeSource,
        embedding: [0.1],
      }),
    ).resolves.toBe(false)
  })
})
