/** Synthetic development tests; external draft, deliberately not executed during W3 gates. */
import { describe, expect, it } from 'vitest'
import { admitGuestDynamicRecords } from './guest-facet-integration'
import { buildVenueSystemPromptParts } from './venue-context'

type Body = { id: string; content: string }
const measure = (knowledge: Body[], places: Body[]) => ({
  chars: [...knowledge, ...places].reduce((total, row) => total + row.content.length + 10, 0),
  fullBodyKeys: [
    ...knowledge.map((row) => `knowledge:${row.id}`),
    ...places.map((row) => `place:${row.id}`),
  ],
})

describe('current whole-body admission after hydration', () => {
  it('drops a grown current body without restoring a stale predecessor or trimming', () => {
    const current = { id: 'grown', content: 'CURRENT'.repeat(40) }
    const result = admitGuestDynamicRecords({
      knowledge: [current],
      places: [],
      priorityKeys: ['knowledge:grown'],
      maxChars: 100,
      measure,
    })
    expect(result.knowledge).toEqual([])
    expect(result.excludedKeys).toEqual(['knowledge:grown'])
    expect(current.content).toBe('CURRENT'.repeat(40))
  })
  it('records a selected source missing after live revalidation', () => {
    const result = admitGuestDynamicRecords({
      knowledge: [],
      places: [],
      priorityKeys: ['knowledge:withdrawn'],
      maxChars: 100,
      measure,
    })
    expect(result.excludedKeys).toEqual(['knowledge:withdrawn'])
    expect(result.fullBodyKeys).toEqual([])
  })
  it('shares a single budget across current existing knowledge and added place bodies', () => {
    const result = admitGuestDynamicRecords({
      knowledge: [{ id: 'existing', content: 'k'.repeat(60) }],
      places: [{ id: 'added', content: 'p'.repeat(40) }],
      priorityKeys: ['knowledge:existing', 'place:added'],
      maxChars: 100,
      measure,
    })
    expect(result.chars).toBe(70)
    expect(result.fullBodyKeys).toEqual(['knowledge:existing'])
    expect(result.excludedKeys).toEqual(['place:added'])
  })
  it('deduplicates current source IDs and preserves all small whole bodies when the union fits', () => {
    const result = admitGuestDynamicRecords({
      knowledge: [
        { id: 'a', content: 'old' },
        { id: 'a', content: 'current' },
      ],
      places: [{ id: 'b', content: 'place' }],
      priorityKeys: [],
      maxChars: 100,
      measure,
    })
    expect(result.knowledge).toEqual([{ id: 'a', content: 'current' }])
    expect(result.fullBodyKeys).toEqual(['knowledge:a', 'place:b'])
  })
})

describe('actual renderer accounting and whole-body IDs', () => {
  const place = {
    id: 'p',
    name: 'Example',
    type: 'ride',
    shortDescription: 'Opening.',
    longDescription: 'Deciding final sentence.',
    areaName: null,
    tags: [],
    hours: null,
  }
  const base = {
    venue: { name: 'Example', description: null, category: null },
    relevantPlaces: [place],
    knowledgeEntries: [
      { id: 'k', title: 'Policy', category: 'General', content: 'First. Governing last sentence.' },
    ],
    userLat: null,
    userLng: null,
  }
  it('reports every rendered full body, including more than eight factual places', () => {
    const parts = buildVenueSystemPromptParts({
      ...base,
      relevantPlaces: Array.from({ length: 11 }, (_, index) => ({
        ...place,
        id: `p${index}`,
        name: `Example ${index}`,
      })),
    })
    expect(parts.recordContext.fullBodyKeys).toHaveLength(12)
    expect(parts.dynamicPart).toContain('Deciding final sentence.')
    expect(parts.recordContext.chars).toBeGreaterThan(100)
  })
  it('never calls names-only guide references whole delivered bodies', () => {
    const parts = buildVenueSystemPromptParts({
      ...base,
      venueGuideRecordIds: new Set(['place:p', 'knowledge:k']),
    })
    expect(parts.recordContext.fullBodyKeys).toEqual([])
    expect(parts.dynamicPart).not.toContain('Deciding final sentence.')
    expect(parts.dynamicPart).not.toContain('Governing last sentence.')
  })
  it('uses exact current rendered wrapper cost for admission', () => {
    const result = admitGuestDynamicRecords({
      knowledge: base.knowledgeEntries,
      places: base.relevantPlaces,
      priorityKeys: [],
      maxChars: 30_000,
      measure: (knowledge, places) =>
        buildVenueSystemPromptParts({
          ...base,
          relevantPlaces: places,
          knowledgeEntries: knowledge,
        }).recordContext,
    })
    expect(result.chars).toBe(buildVenueSystemPromptParts(base).recordContext.chars)
    expect(new Set(result.fullBodyKeys)).toEqual(new Set(['place:p', 'knowledge:k']))
  })
  it('accounts the entire featured body in any unsuppressed renderer invocation', () => {
    const featuredPlace = { name: 'Huge featured stop', blurb: 'F'.repeat(31_000) }
    const parts = buildVenueSystemPromptParts({
      ...base,
      relevantPlaces: [],
      knowledgeEntries: [],
      featuredPlace,
    })
    expect(parts.recordContext.chars).toBeGreaterThan(31_000)
    expect(parts.dynamicPart).toContain(featuredPlace.blurb)
    // A blurb without an identity is not falsely certified as a typed whole source body.
    expect(parts.recordContext.fullBodyKeys).toEqual([])
  })
  it('DIRECTORY suppression prevents an excluded featured body surviving untyped', () => {
    const huge = { ...place, id: 'huge', longDescription: 'UNIQUE-FEATURED-BODY'.repeat(2000) }
    const current = { ...base, relevantPlaces: [huge], featuredPlace: null }
    const result = admitGuestDynamicRecords({
      knowledge: base.knowledgeEntries,
      places: [huge],
      priorityKeys: ['knowledge:k', 'place:huge'],
      maxChars: 30_000,
      measure: (knowledge, places) =>
        buildVenueSystemPromptParts({
          ...current,
          relevantPlaces: places,
          knowledgeEntries: knowledge,
        }).recordContext,
    })
    const final = buildVenueSystemPromptParts({
      ...current,
      relevantPlaces: result.places,
      knowledgeEntries: result.knowledge,
    })
    expect(result.excludedKeys).toContain('place:huge')
    expect(final.dynamicPart).not.toContain('UNIQUE-FEATURED-BODY')
    expect(final.recordContext.fullBodyKeys).not.toContain('place:huge')
    expect(final.recordContext.chars).toBeLessThanOrEqual(30_000)
  })
  it('retains a DIRECTORY body that fits once while avoiding overbudget featured duplication', () => {
    const medium = { ...place, longDescription: 'M'.repeat(16_000) }
    const once = buildVenueSystemPromptParts({
      ...base,
      relevantPlaces: [medium],
      featuredPlace: null,
    })
    const duplicated = buildVenueSystemPromptParts({
      ...base,
      relevantPlaces: [medium],
      featuredPlace: { name: medium.name, blurb: medium.longDescription },
    })
    expect(once.recordContext.chars).toBeLessThan(30_000)
    expect(duplicated.recordContext.chars).toBeGreaterThan(30_000)
    expect(once.dynamicPart.split(medium.longDescription)).toHaveLength(2)
    expect(once.recordContext.fullBodyKeys).toContain('place:p')
  })
})
