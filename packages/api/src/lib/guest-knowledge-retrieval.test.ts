import { describe, expect, it, vi } from 'vitest'

import { retrieveGuestKnowledge, type GuestKnowledgeRow } from './guest-knowledge-retrieval'

function row(
  id: string,
  title: string,
  content: string,
  options: Partial<GuestKnowledgeRow> = {},
): GuestKnowledgeRow {
  return {
    id,
    title,
    content,
    category: 'visitor policy',
    sourceType: 'FOUNDER_PROVIDED',
    sourceName: 'Museum handbook',
    sourceUrl: null,
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    lastReviewedAt: null,
    ...options,
  }
}

describe('retrieveGuestKnowledge', () => {
  it('recovers an old capacity answer without an embedding from bounded scoped queries', async () => {
    const capacity = row(
      'knowledge-capacity-137',
      'Current gallery occupancy',
      'The safe maximum occupancy of the North Gallery is 137 visitors.',
      { lastReviewedAt: new Date('2026-08-20T00:00:00Z') },
    )
    const distractors = Array.from({ length: 60 }, (_, index) =>
      row(`recent-${index}`, 'Recent visitor news', `People can visit gallery program ${index}.`, {
        updatedAt: new Date(`2026-09-01T00:${String(index).padStart(2, '0')}:00Z`),
      }),
    )
    const findMany = vi.fn().mockResolvedValueOnce([capacity]).mockResolvedValueOnce(distractors)

    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'How many guests can fit in the North Gallery?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: null,
      now: () => 10,
    })

    expect(result.entries[0]?.id).toBe('knowledge-capacity-137')
    expect(result.entries[0]?.content).toContain('137')
    expect(result.trace).toMatchObject({
      path: 'lexical-fallback',
      limits: { strict: 20, broad: 60, result: 5 },
      partialCoverage: true,
    })
    expect(result.trace.retrievedSourceIds).toContain('knowledge-capacity-137')
    expect(findMany).toHaveBeenCalledTimes(2)
    for (const call of findMany.mock.calls) {
      expect(call[0]).toMatchObject({
        where: { tenantId: 'tenant-a', venueId: 'venue-a', isEnabled: true, visibility: 'PUBLIC' },
      })
      expect(call[0].take).toBeLessThanOrEqual(60)
    }
  })

  it('retains conflicting public records because title words are not governed lifecycle state', async () => {
    const current = row(
      'photos-current',
      'Current approved photography policy',
      'Cameras are permitted without flash.',
    )
    const stale = row(
      'photos-stale',
      'Archived stale photography policy',
      'All photography is forbidden.',
      { updatedAt: new Date('2026-09-05T00:00:00Z') },
    )
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([stale, current])
      .mockResolvedValueOnce([stale, current])
    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'May I take pictures inside?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: null,
    })
    expect(result.entries.map(({ id }) => id)).toEqual(['photos-stale', 'photos-current'])
    expect(result.trace.excludedSourceIds).not.toContain('photos-stale')
    expect(findMany.mock.calls.every(([args]) => args.where.visibility === 'PUBLIC')).toBe(true)
  })

  it.each([
    ['¿Cuántas personas caben en la galería?', 'capacity-es'],
    ['Quel est le maximum occupancy de la galerie ?', 'capacity-fr'],
  ])('supports multilingual/paraphrased capacity queries: %s', async (query, id) => {
    const capacity = row(id, 'Maximum occupancy', 'Gallery capacity is 137 people.')
    const findMany = vi.fn().mockResolvedValueOnce([capacity]).mockResolvedValueOnce([capacity])
    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: null,
    })
    expect(result.entries.map((entry) => entry.id)).toContain(id)
  })

  it('merges semantic results through the same production function and preserves its bounded result', async () => {
    const lexical = row('lexical', 'Current hours', 'Open until 5 PM.')
    const findMany = vi.fn().mockResolvedValueOnce([lexical]).mockResolvedValueOnce([lexical])
    const semanticSearch = vi.fn().mockResolvedValue([
      {
        id: 'semantic',
        title: 'Hours',
        category: 'hours',
        content: 'Open until 5 PM.',
        sourceType: 'WEBSITE',
        sourceName: null,
        sourceUrl: null,
        distance: 0.1,
      },
    ])
    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'When do you close?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: [0.1],
      semanticSearch,
    })
    expect(result.entries.map(({ id }) => id)).toEqual(['semantic', 'lexical'])
    expect(result.trace.path).toBe('semantic+lexical')
  })

  it('permanently suppresses an activated legacy source across lexical and semantic paths', async () => {
    const legacy = row('legacy-capacity', 'Capacity', 'Capacity was 120.')
    const native = row('native-capacity', 'Capacity', 'Capacity is 137.', {
      contentModuleId: 'module-1',
    })
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([legacy, native])
      .mockResolvedValueOnce([legacy, native])
    const result = await retrieveGuestKnowledge({
      reader: {
        venueKnowledgeEntry: { findMany },
        legacyKnowledgeAdoptionActivation: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ adoption: { legacyKnowledgeEntryId: legacy.id } }]),
        },
      },
      query: 'What is the capacity?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: [0.1],
      semanticSearch: vi.fn().mockResolvedValue([
        { ...legacy, distance: 0.01 },
        { ...native, distance: 0.02 },
      ]),
    })
    expect(result.entries.map(({ id }) => id)).toContain('native-capacity')
    expect(result.entries.map(({ id }) => id)).not.toContain('legacy-capacity')
    expect(result.trace.excludedSourceIds).toContain('legacy-capacity')
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: { AND: expect.arrayContaining([expect.objectContaining({ OR: expect.any(Array) })]) },
    })
  })
})
