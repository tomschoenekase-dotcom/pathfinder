import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  findVenuePackageKnowledgeSemanticDuplicates,
  findVenuePackagePlaceSemanticDuplicates,
  getVenuePackageSemanticCoverage,
  type VenuePackageSemanticDuplicateCandidate,
} from './venue-package-semantic-duplicates'

const queryRaw = vi.fn()
const client = { $queryRaw: queryRaw }
const embedding = Array<number>(1_536).fill(0.001)

function candidate(
  draftIndex = 0,
  vector: number[] = embedding,
): VenuePackageSemanticDuplicateCandidate {
  return { draftIndex, embedding: vector }
}

describe('venue package semantic duplicate helpers', () => {
  beforeEach(() => {
    queryRaw.mockReset()
  })

  it('validates scope, profiles, distance, candidate identity, dimensions, and finite values', async () => {
    await expect(
      getVenuePackageSemanticCoverage(client, {
        tenantId: '',
        venueId: 'venue_1',
        placeProfile: 'profile:place',
        knowledgeProfile: 'profile:knowledge',
        scanPlaces: true,
        scanKnowledgeEntries: true,
      }),
    ).rejects.toThrow('Semantic duplicate scope and profile are required')

    const base = {
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      profile: 'profile:place',
      maxCosineDistance: 0.14,
    }
    await expect(
      findVenuePackagePlaceSemanticDuplicates(client, {
        ...base,
        maxCosineDistance: Number.NaN,
        candidates: [candidate()],
      }),
    ).rejects.toThrow('Semantic duplicate cosine distance must be between 0 and 2')
    await expect(
      findVenuePackagePlaceSemanticDuplicates(client, {
        ...base,
        candidates: [candidate(-1)],
      }),
    ).rejects.toThrow('Semantic duplicate draft indexes must be unique nonnegative integers')
    await expect(
      findVenuePackagePlaceSemanticDuplicates(client, {
        ...base,
        candidates: [candidate(0), candidate(0)],
      }),
    ).rejects.toThrow('Semantic duplicate draft indexes must be unique nonnegative integers')
    await expect(
      findVenuePackagePlaceSemanticDuplicates(client, {
        ...base,
        candidates: [candidate(0, embedding.slice(1))],
      }),
    ).rejects.toThrow('Semantic duplicate embeddings must contain 1536 finite values')
    const nonfinite = [...embedding]
    nonfinite[100] = Number.POSITIVE_INFINITY
    await expect(
      findVenuePackagePlaceSemanticDuplicates(client, {
        ...base,
        candidates: [candidate(0, nonfinite)],
      }),
    ).rejects.toThrow('Semantic duplicate embeddings must contain 1536 finite values')
    await expect(
      findVenuePackagePlaceSemanticDuplicates(client, {
        ...base,
        candidates: Array.from({ length: 501 }, (_, index) => candidate(index)),
      }),
    ).rejects.toThrow('Semantic duplicate candidates cannot exceed 500')
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('maps coverage counts and binds both profiles, scan choices, tenant, and venue', async () => {
    queryRaw.mockResolvedValueOnce([
      {
        place_eligible: '7',
        place_searchable: 4,
        place_missing: '2',
        place_incompatible: 1,
        knowledge_eligible: 5,
        knowledge_searchable: '3',
        knowledge_missing: 1,
        knowledge_incompatible: '1',
      },
    ])

    await expect(
      getVenuePackageSemanticCoverage(client, {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        placeProfile: 'openai:place:1536',
        knowledgeProfile: 'openai:knowledge:1536',
        scanPlaces: true,
        scanKnowledgeEntries: false,
      }),
    ).resolves.toEqual({
      places: {
        eligibleCount: 7,
        searchableCount: 4,
        missingVectorCount: 2,
        incompatibleVectorCount: 1,
      },
      knowledgeEntries: {
        eligibleCount: 5,
        searchableCount: 3,
        missingVectorCount: 1,
        incompatibleVectorCount: 1,
      },
    })

    expect(queryRaw).toHaveBeenCalledOnce()
    expect(queryRaw.mock.calls[0]?.slice(1)).toEqual([
      'openai:place:1536',
      true,
      'tenant_1',
      'venue_1',
      'openai:knowledge:1536',
      false,
      'tenant_1',
      'venue_1',
    ])
    expect((queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?')).toContain(
      'claim.content_updated_at = p.updated_at',
    )
  })

  it('rejects a missing coverage row instead of inventing completeness', async () => {
    queryRaw.mockResolvedValueOnce([])

    await expect(
      getVenuePackageSemanticCoverage(client, {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        placeProfile: 'profile:place',
        knowledgeProfile: 'profile:knowledge',
        scanPlaces: true,
        scanKnowledgeEntries: true,
      }),
    ).rejects.toThrow('Semantic duplicate coverage query returned no row')
  })

  it('maps deterministic place matches and sends bounded vectors through tagged raw SQL', async () => {
    queryRaw.mockResolvedValueOnce([
      {
        draft_index: '2',
        existing_id: 'place_a',
        existing_label: 'Main Hall',
        cosine_distance: '0.04',
      },
    ])

    await expect(
      findVenuePackagePlaceSemanticDuplicates(client, {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        profile: 'openai:place:1536',
        maxCosineDistance: 0.14,
        candidates: [candidate(2)],
      }),
    ).resolves.toEqual([
      {
        entityType: 'PLACE',
        draftIndex: 2,
        existingId: 'place_a',
        existingLabel: 'Main Hall',
        cosineDistance: 0.04,
      },
    ])

    const [strings, candidatesJson, profile, tenantId, venueId, threshold] =
      queryRaw.mock.calls[0] ?? []
    const parsedCandidates = JSON.parse(candidatesJson as string) as Array<{
      draftIndex: number
      vectorText: string
    }>
    expect(parsedCandidates).toHaveLength(1)
    expect(parsedCandidates[0]?.draftIndex).toBe(2)
    expect(parsedCandidates[0]?.vectorText).toMatch(/^\[0\.001,0\.001,/u)
    expect(parsedCandidates[0]?.vectorText).toMatch(/0\.001\]$/u)
    expect([profile, tenantId, venueId, threshold]).toEqual([
      'openai:place:1536',
      'tenant_1',
      'venue_1',
      0.14,
    ])
    const sql = (strings as TemplateStringsArray).join('?')
    expect(sql).toContain('ORDER BY (existing.embedding <=> draft.embedding) ASC, existing.id ASC')
    expect(sql).toContain(
      'ORDER BY draft.draft_index ASC, matched.cosine_distance ASC, matched.id ASC',
    )
  })

  it('maps knowledge matches with the distinct entity type and skips SQL for empty candidates', async () => {
    queryRaw.mockResolvedValueOnce([
      {
        draft_index: 1,
        existing_id: 'knowledge_a',
        existing_label: 'Refund policy',
        cosine_distance: 0,
      },
    ])

    await expect(
      findVenuePackageKnowledgeSemanticDuplicates(client, {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        profile: 'openai:knowledge:1536',
        maxCosineDistance: 0.2,
        candidates: [candidate(1)],
      }),
    ).resolves.toEqual([
      {
        entityType: 'KNOWLEDGE_ENTRY',
        draftIndex: 1,
        existingId: 'knowledge_a',
        existingLabel: 'Refund policy',
        cosineDistance: 0,
      },
    ])

    queryRaw.mockClear()
    await expect(
      findVenuePackageKnowledgeSemanticDuplicates(client, {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        profile: 'openai:knowledge:1536',
        maxCosineDistance: 0.2,
        candidates: [],
      }),
    ).resolves.toEqual([])
    expect(queryRaw).not.toHaveBeenCalled()
  })
})
