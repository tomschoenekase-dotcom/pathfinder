import { describe, expect, it, vi } from 'vitest'

import { retrieveGuestKnowledge } from '../guest-knowledge-retrieval'
import { fuseGuestPlacesWithLexical } from '../guest-place-lexical'
import {
  GUEST_ANSWER_QUALITY_SCENARIOS,
  THEME_PARK_KEY_IDS as K,
  THEME_PARK_OPERATING_COASTER_IDS,
  THEME_PARK_PLACES,
  THEME_PARK_RECORDS,
  THEME_PARK_SCOPE,
  WILDLIFE_PARK_KEY_IDS,
  WILDLIFE_PARK_RECORDS,
  WILDLIFE_PARK_SCOPE,
  createFakeKnowledgeReader,
  createFakeSemanticSearch,
} from './guest-answer-quality-corpus'

// The production chat route requests this many vector neighbours (chat.ts KNOWLEDGE_ENTRIES_LIMIT).
const SEMANTIC_POOL = 12

async function retrieveForTurns(turns: string[], venue: 'theme-park' | 'wildlife-park') {
  const records = venue === 'theme-park' ? THEME_PARK_RECORDS : WILDLIFE_PARK_RECORDS
  const scope = venue === 'theme-park' ? THEME_PARK_SCOPE : WILDLIFE_PARK_SCOPE
  const query = turns.at(-1)!
  return retrieveGuestKnowledge({
    reader: createFakeKnowledgeReader(records),
    query,
    previousQuery: turns.length > 1 ? turns.at(-2)! : null,
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    includeSecondLayer: false,
    queryEmbedding: [1],
    semanticSearch: createFakeSemanticSearch(records, query, SEMANTIC_POOL),
  })
}

function scenario(id: string) {
  const found = GUEST_ANSWER_QUALITY_SCENARIOS.find((item) => item.id === id)
  if (!found) throw new Error(`Unknown scenario ${id}`)
  return found
}

describe('guest answer-quality retrieval on a large partially embedded venue', () => {
  it.each([
    'coaster-count-after-explain',
    'paraphrase-roller-coasters',
    'follow-up-five-year-old',
    'explain-place-overview',
    'paraphrase-park-about',
    'paraphrase-rundown',
    'paraphrase-something-sweet',
    'water-realm-quick-bite',
    'safety-grill-nut-free',
    'safety-dessert-allergy',
    'live-launch-coaster-open',
    'accessibility-wheelchair-fire-coaster',
    'wildlife-repeat-loop',
    'wildlife-giraffe-with-viewing-area',
    'wildlife-giraffe-story-only',
  ])('brings every required record for %s into model context', async (id) => {
    const item = scenario(id)
    const result = await retrieveForTurns(item.turns, item.venue)
    const ids = result.entries.map((entry) => entry.id)
    expect(ids).toEqual(expect.arrayContaining(item.mustRetrieveIds))
  })

  it('retrieves the complete coaster inventory after an overview turn, including un-embedded rows', async () => {
    const result = await retrieveForTurns(
      ['Explain this place to me.', 'How many coasters are there'],
      'theme-park',
    )
    const ids = result.entries.map((entry) => entry.id)
    expect(ids).toEqual(expect.arrayContaining([...THEME_PARK_OPERATING_COASTER_IDS]))
    // The junior coaster has no stored embedding; only the lexical lane can supply it.
    expect(ids).toContain(K.juniorCoaster)
    expect(result.trace.limits.result).toBeGreaterThanOrEqual(
      THEME_PARK_OPERATING_COASTER_IDS.length,
    )
  })

  it('answers a broad dining question from the dining overview plus several outlets, not one stand', async () => {
    const result = await retrieveForTurns(['Where to eat'], 'theme-park')
    const ids = result.entries.map((entry) => entry.id)
    expect(ids).toContain(K.diningOverview)
    const diningRecords = result.entries.filter((entry) => /dining/i.test(entry.category))
    expect(diningRecords.length).toBeGreaterThanOrEqual(4)
  })

  it('keeps broad context within the total prompt character budget', async () => {
    const result = await retrieveForTurns(['Where to eat'], 'theme-park')
    const total = result.entries.reduce((sum, entry) => sum + entry.content.length, 0)
    expect(result.entries.length).toBeLessThanOrEqual(12)
    expect(total).toBeLessThanOrEqual(20_000 + result.entries.length * 64)
  })

  it('does not widen a specific question to the broad budget', async () => {
    const result = await retrieveForTurns(['is the grill nut free?'], 'theme-park')
    expect(result.trace.limits.result).toBe(8)
  })

  it('does not let "eat" match unrelated words such as great or seat', async () => {
    const records = [
      ...THEME_PARK_RECORDS.filter((record) => record.row.id === K.diningOverview),
      {
        ...THEME_PARK_RECORDS[0]!,
        row: {
          ...THEME_PARK_RECORDS[0]!.row,
          id: 'kb-theater-seating',
          title: 'Great seats at the theater',
          category: 'Shows',
          content: 'Arrive early for great seats; the theater repeats every hour.',
        },
      },
    ]
    const result = await retrieveGuestKnowledge({
      reader: createFakeKnowledgeReader(records),
      query: 'Where to eat',
      tenantId: THEME_PARK_SCOPE.tenantId,
      venueId: THEME_PARK_SCOPE.venueId,
      includeSecondLayer: false,
      queryEmbedding: null,
    })
    expect(result.entries.map((entry) => entry.id)).toEqual([K.diningOverview])
  })

  it('keeps wildlife-park record ids distinct from the theme park', () => {
    expect(Object.values(WILDLIFE_PARK_KEY_IDS)).not.toContain(K.overview)
  })
})

describe('guest place lexical fusion', () => {
  const unembeddedRestaurant = THEME_PARK_PLACES.find((place) =>
    /grill|market|cafe|fry/i.test(place.name),
  )!

  it('surfaces a text-matched place that semantic search cannot return', async () => {
    const findMany = vi.fn().mockResolvedValue([unembeddedRestaurant])
    const semanticPlaces = THEME_PARK_PLACES.filter((place) => place.id !== unembeddedRestaurant.id)
      .slice(0, 8)
      .map((place) => ({ ...place, distance: 0.4 }))
    const places = await fuseGuestPlacesWithLexical({
      reader: { place: { findMany } },
      query: 'Where to eat',
      tenantId: THEME_PARK_SCOPE.tenantId,
      venueId: THEME_PARK_SCOPE.venueId,
      includeSecondLayer: false,
      semanticPlaces,
      limit: 8,
      userLat: null,
      userLng: null,
    })
    expect(places.map((place) => place.id)).toContain(unembeddedRestaurant.id)
    expect(places.length).toBeLessThanOrEqual(12)
    expect(findMany.mock.calls[0]![0].where).toMatchObject({
      tenantId: THEME_PARK_SCOPE.tenantId,
      venueId: THEME_PARK_SCOPE.venueId,
      isActive: true,
      visibility: 'PUBLIC',
    })
  })

  it('returns the semantic list unchanged when the query has no lexical concepts', async () => {
    const findMany = vi.fn()
    const semanticPlaces = THEME_PARK_PLACES.slice(0, 3).map((place) => ({
      ...place,
      distance: 0.2,
    }))
    const places = await fuseGuestPlacesWithLexical({
      reader: { place: { findMany } },
      query: 'AI?',
      tenantId: THEME_PARK_SCOPE.tenantId,
      venueId: THEME_PARK_SCOPE.venueId,
      includeSecondLayer: false,
      semanticPlaces,
      limit: 8,
      userLat: null,
      userLng: null,
    })
    expect(places).toEqual(semanticPlaces)
    expect(findMany).not.toHaveBeenCalled()
  })

  it('keeps semantic places when the lexical read fails', async () => {
    const semanticPlaces = THEME_PARK_PLACES.slice(0, 3).map((place) => ({
      ...place,
      distance: 0.2,
    }))
    const places = await fuseGuestPlacesWithLexical({
      reader: { place: { findMany: vi.fn().mockRejectedValue(new Error('db unavailable')) } },
      query: 'Where to eat',
      tenantId: THEME_PARK_SCOPE.tenantId,
      venueId: THEME_PARK_SCOPE.venueId,
      includeSecondLayer: false,
      semanticPlaces,
      limit: 8,
      userLat: null,
      userLng: null,
    })
    expect(places).toEqual(semanticPlaces)
  })
})
