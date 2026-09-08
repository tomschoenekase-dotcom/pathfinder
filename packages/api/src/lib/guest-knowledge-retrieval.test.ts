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

  it('expands the recognized two-letter WC concept before applying the generic token length bound', async () => {
    const restroom = row('restroom-wc', 'Visitor restroom', 'The nearest bathroom is by the lobby.')
    const findMany = vi.fn(async (args: Record<string, unknown>) => {
      const queryShape = JSON.stringify(args.where)
      expect(queryShape).toContain('"contains":"wc"')
      expect(queryShape).toContain('"contains":"restroom"')
      return [restroom]
    })

    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'WC?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: null,
    })

    expect(result.entries.map(({ id }) => id)).toEqual(['restroom-wc'])
    expect(findMany).toHaveBeenCalledTimes(2)
  })

  it('keeps a recognized short concept after more than eight leading stop words', async () => {
    const restroom = row(
      'restroom-verbose-wc',
      'Visitor restroom',
      'The nearest bathroom is by the lobby.',
    )
    const findMany = vi.fn(async (args: Record<string, unknown>) => {
      expect(JSON.stringify(args.where)).toContain('"contains":"wc"')
      return [restroom]
    })

    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'please can you what is the of a where WC',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: null,
    })

    expect(result.entries.map(({ id }) => id)).toEqual(['restroom-verbose-wc'])
  })

  it.each([
    ['厕所在哪？', '厕所'],
    ['トイレはどこですか', 'トイレ'],
  ])(
    'finds a scoped restroom fact from an embedding-dark no-space query: %s',
    async (query, term) => {
      const restroom = row(
        `restroom-${term}`,
        'Restroom location',
        'The toilets are beside the lobby.',
      )
      const asOf = new Date('2026-09-07T12:00:00.000Z')
      const findMany = vi.fn(async (args: Record<string, unknown>) => {
        const typed = args as { where: Record<string, unknown>; take: number }
        const queryShape = JSON.stringify(typed.where)
        expect(typed.where).toMatchObject({
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          isEnabled: true,
          visibility: 'PUBLIC',
        })
        expect(queryShape).toContain(`"contains":"${term}"`)
        expect(queryShape).toContain(asOf.toISOString())
        expect(typed.take).toBeLessThanOrEqual(60)
        return [restroom]
      })

      const result = await retrieveGuestKnowledge({
        reader: { venueKnowledgeEntry: { findMany } },
        query,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        includeSecondLayer: false,
        queryEmbedding: null,
        asOf,
      })

      expect(result.entries.map(({ id }) => id)).toEqual([`restroom-${term}`])
      expect(result.trace.path).toBe('lexical-fallback')
    },
  )

  it('recognizes an hours concept inside a natural Chinese no-space query', async () => {
    const hours = row('hours-zh', 'Current opening hours', 'The museum is open from 9 AM to 5 PM.')
    const findMany = vi.fn(async (args: Record<string, unknown>) => {
      expect(JSON.stringify(args.where)).toContain('"contains":"营业时间"')
      return [hours]
    })

    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: '博物馆营业时间是什么？',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: null,
    })

    expect(result.entries.map(({ id }) => id)).toEqual(['hours-zh'])
    expect(findMany).toHaveBeenCalledTimes(2)
  })

  it('expands Spanish arrival language to English entrance guidance without an embedding', async () => {
    const arrival = row(
      'public-arrival',
      'Public arrival guide',
      'Visitors should use the east entrance.',
    )
    const findMany = vi.fn(async (args: Record<string, unknown>) => {
      const queryShape = JSON.stringify(args.where)
      expect(queryShape).toContain('"contains":"llegada"')
      expect(queryShape).toContain('"contains":"entrance"')
      return [arrival]
    })

    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: '¿Qué debo saber sobre la llegada a la galería pública?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: null,
    })

    expect(result.entries.map((entry) => entry.id)).toEqual(['public-arrival'])
    expect(findMany).toHaveBeenCalledTimes(2)
  })

  it('retains distinct restroom and hours concepts from one Chinese token', async () => {
    const hours = row(
      'restroom-hours-zh',
      'Restroom opening hours',
      'The lobby toilets are open from 9 AM to 5 PM.',
    )
    const findMany = vi.fn(async (args: Record<string, unknown>) => {
      const queryShape = JSON.stringify(args.where)
      expect(queryShape).toContain('"contains":"厕所"')
      expect(queryShape).toContain('"contains":"营业时间"')
      return [hours]
    })

    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: '厕所营业时间是什么？',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: null,
    })

    expect(result.entries.map(({ id }) => id)).toEqual(['restroom-hours-zh'])
  })

  it('does not turn an unrecognized short token into an all-public-content scan', async () => {
    const findMany = vi.fn(async (args: Record<string, unknown>) => {
      expect(args.where).toMatchObject({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        visibility: 'PUBLIC',
        id: '__no_query_terms__',
      })
      return []
    })

    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'AI?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: null,
    })

    expect(result.entries).toEqual([])
    expect(findMany).toHaveBeenCalledTimes(2)
  })

  it('merges semantic results through the same production function and preserves its bounded result', async () => {
    const lexical = row('lexical', 'Current hours', 'Open until 5 PM.')
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([lexical])
      .mockResolvedValueOnce([lexical])
      .mockResolvedValueOnce([row('semantic', 'Hours', 'Open until 5 PM.', { category: 'hours' })])
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

  it('uses current scoped content and version instead of an earlier semantic snapshot', async () => {
    const prior = row('hours', 'Hours', 'Open until 10 PM.')
    const current = {
      ...prior,
      content: 'Open until 5 PM.',
      updatedAt: new Date('2026-09-08T00:00:00Z'),
    }
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([current])
    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'Hours?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: [0.1],
      semanticSearch: vi.fn().mockResolvedValue([{ ...prior, distance: 0.01 }]),
    })
    expect(result.entries).toMatchObject([{ id: 'hours', content: 'Open until 5 PM.' }])
    expect(result.trace.retrievedSources).toEqual([
      { id: 'hours', version: current.updatedAt.toISOString() },
    ])
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          isEnabled: true,
          visibility: 'PUBLIC',
          id: { in: ['hours'] },
        }),
        take: 20,
      }),
    )
  })

  it('does not let an unrelated correction retain stale semantic priority', async () => {
    const stale = row('corrected', 'Opening hours', 'Open until 10 PM.')
    const corrected = {
      ...stale,
      title: 'Membership renewal',
      content: 'Annual memberships renew online.',
      updatedAt: new Date('2026-09-08T00:00:00Z'),
      lastReviewedAt: new Date('2026-09-08T00:00:00Z'),
    }
    const relevant = Array.from({ length: 5 }, (_, index) =>
      row(`hours-${index}`, `Opening hours ${index}`, `Open until ${index + 1} PM.`),
    )
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(relevant)
      .mockResolvedValueOnce(relevant)
      .mockResolvedValueOnce([corrected])

    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'Opening hours?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: [0.1],
      semanticSearch: vi.fn().mockResolvedValue([{ ...stale, distance: 0.001 }]),
    })

    expect(result.entries.map((entry) => entry.id)).toEqual(relevant.map((entry) => entry.id))
    expect(result.trace.excludedSourceIds).toContain(corrected.id)
  })

  it('excludes a reviewed unrelated correction when no relevant candidates exist', async () => {
    const stale = row('corrected-only', 'Opening hours', 'Open until 10 PM.')
    const corrected = {
      ...stale,
      title: 'Membership renewal',
      content: 'Annual memberships renew online.',
      lastReviewedAt: new Date('2026-09-08T00:00:00Z'),
    }
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([corrected])

    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'Opening hours?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: [0.1],
      semanticSearch: vi.fn().mockResolvedValue([{ ...stale, distance: 0.001 }]),
    })

    expect(result.entries).toEqual([])
    expect(result.trace.excludedSourceIds).toContain(corrected.id)
  })

  it('does not preserve embedding relevance after the category alone changes', async () => {
    const prior = row('recategorized', 'Museum guide', 'Welcome to the museum.', {
      category: 'Opening hours',
    })
    const current = { ...prior, category: 'Membership' }
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([current])
    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'Opening hours?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: [0.1],
      semanticSearch: vi.fn().mockResolvedValue([{ ...prior, distance: 0.01 }]),
    })
    expect(result.entries).toEqual([])
    expect(result.trace.excludedSourceIds).toContain(prior.id)
  })

  it('excludes a semantic source that has disappeared from the current public scope', async () => {
    const prior = row('private-now', 'Hours', 'Private current hours.')
    const findMany = vi.fn().mockResolvedValue([])
    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'Hours?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: [0.1],
      semanticSearch: vi.fn().mockResolvedValue([{ ...prior, distance: 0.01 }]),
    })
    expect(result.entries).toEqual([])
    expect(result.trace.excludedSourceIds).toContain(prior.id)
  })

  it('bounds semantic source readback and reports candidates outside the bound', async () => {
    const sources = Array.from({ length: 21 }, (_, index) =>
      row(`source-${index}`, 'Hours', 'Open until 5 PM.'),
    )
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(sources.slice(0, 20))
    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'Hours?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: [0.1],
      semanticSearch: vi
        .fn()
        .mockResolvedValue(sources.map((source) => ({ ...source, distance: 0.1 }))),
    })
    expect(findMany.mock.calls[2]![0].where.id.in).toHaveLength(20)
    expect(findMany.mock.calls[2]![0].take).toBe(20)
    expect(result.entries).toHaveLength(5)
    expect(result.trace.partialCoverage).toBe(true)
    expect(result.trace.excludedSourceIds).toContain('source-20')
  })

  it('does not reuse retained semantic content when authority readback fails', async () => {
    const prior = row('hours', 'Hours', 'Open until 10 PM.')
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('authority unavailable'))
    await expect(
      retrieveGuestKnowledge({
        reader: { venueKnowledgeEntry: { findMany } },
        query: 'Hours?',
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        includeSecondLayer: false,
        queryEmbedding: [0.1],
        semanticSearch: vi.fn().mockResolvedValue([{ ...prior, distance: 0.01 }]),
      }),
    ).rejects.toThrow('authority unavailable')
  })

  it('does not reintroduce a rejected publication from a semantic candidate', async () => {
    const stale = row('withdrawn-hours', 'Opening hours', 'Open until 10 PM.', {
      contentModuleId: 'hours-module',
      contentRevisionId: 'hours-revision',
      contentPublicationId: 'old-publication',
      contentPublication: {
        eventOrder: 1n,
        module: { publications: [{ id: 'withdrawal', eventOrder: 2n }] },
      },
    })
    const findMany = vi.fn().mockResolvedValue([stale])
    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query: 'Opening hours?',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: [0.1],
      semanticSearch: vi.fn().mockResolvedValue([{ ...stale, distance: 0.01 }]),
    })
    expect(result.entries).toEqual([])
    expect(result.trace.excludedSourceIds).toContain(stale.id)
  })

  it('permanently suppresses an activated legacy source across lexical and semantic paths', async () => {
    const legacy = row('legacy-capacity', 'Capacity', 'Capacity was 120.')
    const native = row('native-capacity', 'Capacity', 'Capacity is 137.', {
      contentModuleId: 'module-1',
      contentRevisionId: 'revision-1',
      contentPublicationId: 'publication-1',
      contentPublication: {
        eventOrder: 1n,
        module: { publications: [{ id: 'publication-1', eventOrder: 1n }] },
      },
    })
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([legacy, native])
      .mockResolvedValueOnce([legacy, native])
      .mockResolvedValueOnce([native])
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
