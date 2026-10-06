import { describe, expect, it } from 'vitest'

import {
  GUEST_ANSWER_QUALITY_SCENARIOS,
  THEME_PARK_KEY_IDS,
  THEME_PARK_KNOWLEDGE,
  THEME_PARK_PLACES,
  THEME_PARK_RECORDS,
  THEME_PARK_SCOPE,
  WILDLIFE_PARK_KNOWLEDGE,
  WILDLIFE_PARK_RECORDS,
  WILDLIFE_PARK_SCOPE,
  createFakeKnowledgeReader,
  fakeSemanticSearch,
  toStoredRecords,
} from './guest-answer-quality-corpus'

const publicScope = {
  isEnabled: true,
  sourceType: { not: 'SOURCE_CONNECTION' },
  visibility: 'PUBLIC',
}

describe('guest answer quality corpus', () => {
  it('has the expected shape and unique ids', () => {
    for (const entries of [THEME_PARK_KNOWLEDGE, WILDLIFE_PARK_KNOWLEDGE]) {
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
      for (const entry of entries) {
        expect(entry.sourceType).toBe('MANUAL')
        expect(entry.contentModuleId).toBeNull()
        expect(entry.contentRevisionId).toBeNull()
        expect(entry.updatedAt).toBeInstanceOf(Date)
        expect(entry.content.length).toBeGreaterThan(20)
      }
    }
    expect(THEME_PARK_KNOWLEDGE.length).toBeGreaterThanOrEqual(100)
    expect(THEME_PARK_PLACES).toHaveLength(20)
    expect(new Set(THEME_PARK_PLACES.map((place) => place.id)).size).toBe(20)
    const unembedded = THEME_PARK_KNOWLEDGE.filter((entry) => !entry.hasEmbedding)
    expect(unembedded.length).toBeGreaterThanOrEqual(35)
    expect(unembedded.length).toBeLessThanOrEqual(45)
    const byId = new Map(THEME_PARK_KNOWLEDGE.map((entry) => [entry.id, entry]))
    for (const id of [
      THEME_PARK_KEY_IDS.overview,
      THEME_PARK_KEY_IDS.diningOverview,
      THEME_PARK_KEY_IDS.grill,
      THEME_PARK_KEY_IDS.market,
      THEME_PARK_KEY_IDS.juniorCoaster,
    ]) {
      expect(byId.get(id)?.hasEmbedding).toBe(false)
    }
    expect(byId.get(THEME_PARK_KEY_IDS.darkRide)?.sourceUrl).toContain('/rides/rollercoasters/')
  })

  it('only references existing entries from scenarios', () => {
    const ids = {
      'theme-park': new Set(THEME_PARK_KNOWLEDGE.map((entry) => entry.id)),
      'wildlife-park': new Set(WILDLIFE_PARK_KNOWLEDGE.map((entry) => entry.id)),
    }
    expect(new Set(GUEST_ANSWER_QUALITY_SCENARIOS.map((s) => s.id)).size).toBe(
      GUEST_ANSWER_QUALITY_SCENARIOS.length,
    )
    for (const scenario of GUEST_ANSWER_QUALITY_SCENARIOS) {
      expect(scenario.turns.length).toBeGreaterThan(0)
      expect(scenario.mustRetrieveIds.length).toBeGreaterThan(0)
      for (const id of [...scenario.mustRetrieveIds, ...(scenario.mustNotCountIds ?? [])]) {
        expect(ids[scenario.venue].has(id)).toBe(true)
      }
    }
  })

  it('fake reader filters by tenant, venue, enablement and visibility', async () => {
    const secondLayer = toStoredRecords(THEME_PARK_KNOWLEDGE.slice(0, 2), THEME_PARK_SCOPE, {
      visibility: 'SECOND_LAYER',
    }).map((record) => ({ ...record, row: { ...record.row, id: `${record.row.id}-hidden` } }))
    const disabled = toStoredRecords(THEME_PARK_KNOWLEDGE.slice(2, 3), THEME_PARK_SCOPE, {
      isEnabled: false,
    }).map((record) => ({ ...record, row: { ...record.row, id: `${record.row.id}-off` } }))
    const reader = createFakeKnowledgeReader([
      ...THEME_PARK_RECORDS,
      ...WILDLIFE_PARK_RECORDS,
      ...secondLayer,
      ...disabled,
    ])

    const wildlife = await reader.venueKnowledgeEntry.findMany({
      where: { ...publicScope, ...WILDLIFE_PARK_SCOPE },
    })
    expect(wildlife.map((row) => row.id).sort()).toEqual(
      WILDLIFE_PARK_KNOWLEDGE.map((entry) => entry.id).sort(),
    )

    const park = await reader.venueKnowledgeEntry.findMany({
      where: { ...publicScope, ...THEME_PARK_SCOPE },
    })
    expect(park).toHaveLength(THEME_PARK_KNOWLEDGE.length)
    expect(park.some((row) => row.id.endsWith('-hidden') || row.id.endsWith('-off'))).toBe(false)

    const withSecondLayer = await reader.venueKnowledgeEntry.findMany({
      where: { isEnabled: true, ...THEME_PARK_SCOPE },
    })
    expect(withSecondLayer).toHaveLength(THEME_PARK_KNOWLEDGE.length + 2)

    expect(
      await reader.venueKnowledgeEntry.findMany({
        where: { ...publicScope, tenantId: THEME_PARK_SCOPE.tenantId, venueId: 'other' },
      }),
    ).toEqual([])
  })

  it('evaluates the retrieval where shape, ordering and take', async () => {
    const reader = createFakeKnowledgeReader(THEME_PARK_RECORDS)
    const rows = await reader.venueKnowledgeEntry.findMany({
      where: {
        ...THEME_PARK_SCOPE,
        ...publicScope,
        AND: [
          {
            OR: [
              { contentModuleId: null },
              {
                contentPublication: { action: 'PUBLISH' },
                contentRevision: { audience: 'PUBLIC' },
              },
            ],
          },
          { OR: [{ contentModuleId: { not: null } }, { universalContentAdoption: { is: null } }] },
          {
            OR: [
              { contentRevisionId: null },
              { contentRevision: { is: { NOT: { createdBy: { startsWith: 'x' } } } } },
            ],
          },
          {
            OR: [
              { title: { contains: 'REALM', mode: 'insensitive' } },
              { content: { contains: 'RIDE', mode: 'insensitive' } },
            ],
          },
        ],
      },
      orderBy: [{ lastReviewedAt: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      take: 3,
    })
    expect(rows).toHaveLength(3)
    expect(rows[0]).not.toHaveProperty('hasEmbedding')
    // PostgreSQL sorts NULL first on DESC, so the never-reviewed rows lead.
    expect(rows[0]!.lastReviewedAt).toBeNull()
  })

  it('fake semantic search excludes rows without embeddings', () => {
    const results = fakeSemanticSearch({
      records: THEME_PARK_RECORDS,
      ...THEME_PARK_SCOPE,
      includeSecondLayer: false,
      query: 'where to eat dining grill market overview junior coaster',
      limit: THEME_PARK_RECORDS.length,
    })
    const unembedded = new Set(
      THEME_PARK_KNOWLEDGE.filter((entry) => !entry.hasEmbedding).map((entry) => entry.id),
    )
    expect(results).toHaveLength(THEME_PARK_KNOWLEDGE.length - unembedded.size)
    expect(results.some((entry) => unembedded.has(entry.id))).toBe(false)
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i]!.distance).toBeGreaterThanOrEqual(results[i - 1]!.distance)
    }
    expect(
      fakeSemanticSearch({
        records: THEME_PARK_RECORDS,
        tenantId: 'x',
        venueId: 'y',
        includeSecondLayer: false,
        query: 'dining',
      }),
    ).toEqual([])
  })
})
