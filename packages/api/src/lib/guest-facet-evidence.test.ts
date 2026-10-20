/** EXTERNAL DRAFT synthetic development tests. Not executed during W3/W4 gates. */
import { describe, expect, it } from 'vitest'
import {
  classifyFacets,
  extractRecordFacets,
  extractRecordFacetHints,
  facetCoverage,
  recognizedStatementCountLines,
  selectFacetRecords,
  softFacetPriority,
  type FacetRecord,
} from './guest-facet-evidence'

const body =
  'Minimum age: 6 years; Maximum age: 12 years; Minimum height: 44 inches; Adult accompaniment: not required; Duration: 15 minutes; Price: USD 5; Access: step-free; Included in admission: yes; Kind: ride'
const constraints = {
  ageYears: 7,
  heightCm: 46 * 2.54,
  adultPresent: false,
  maxDurationMinutes: 20,
  maxPrice: { amount: 8, currency: 'USD' as const },
  access: 'step-free' as const,
  included: true,
  kind: 'ride' as const,
}
const record = (key: string, text = body, chars = 100): FacetRecord => {
  const extraction = extractRecordFacetHints(text)
  return { key, facets: extraction.hard, softFacets: extraction.soft, chars }
}

describe('conservative record-text selection hints', () => {
  it('recognizes ordinary named narrative as soft hints while all hard fields stay unknown', () => {
    const text =
      'Oak Glider. Riders must be at least 6 years old. The maximum age is 12 years. Riders must be at least 44 inches tall. Adult accompaniment is not required. The ride lasts 15 minutes. Tickets cost USD 5. This ride is step-free. This ride is included in admission. This is a ride.'
    const extraction = extractRecordFacetHints(text)
    expect(extraction.completeGrammar).toBe(false)
    expect(Object.values(extraction.hard).every((value) => value === null)).toBe(true)
    expect(extraction.soft).toEqual({
      minAge: 6,
      maxAge: 12,
      minHeightCm: 44 * 2.54,
      adultRequired: false,
      durationMinutes: 15,
      price: { currency: 'USD', amount: 5 },
      access: 'step-free',
      included: true,
      kind: 'ride',
    })
    expect(softFacetPriority(extraction.soft, constraints)).toBeGreaterThan(0)
    const row = record('place:narrative', text)
    expect(
      selectFacetRecords({ records: [row], constraints, governingKeys: [], maxChars: 100 })
        .requiredKeys,
    ).toContain(row.key)
    expect(
      recognizedStatementCountLines({
        records: [row],
        freshCompleteAuthorizedIndex: true,
        hydrationVersionConsistent: true,
      }),
    ).toContain('Records with recognized explicit minAge statement: 0')
  })
  it.each([
    'Younger and shorter visitors may participate with a guardian.',
    'Special arrangements are described at the host desk.',
    'The host can offer another experience on request.',
  ])('keeps natural-rule records required despite arbitrary exception prose: %s', (exception) => {
    const text = `Copper Twist. Riders must be at least 8 years old. Riders must be at least 48 inches tall. ${exception}`
    const row = record('place:exception-natural', text)
    expect(row.softFacets!.minAge).toBe(8)
    expect(row.softFacets!.minHeightCm).toBe(48 * 2.54)
    expect(classifyFacets(row.facets, constraints).failures).toEqual([])
    expect(
      selectFacetRecords({ records: [row], constraints, governingKeys: [], maxChars: 100 })
        .selectedKeys,
    ).toContain(row.key)
  })
  it('does not assume currency, conditional adult requirements, approximate duration or access alternatives', () => {
    const extraction = extractRecordFacetHints(
      'Harbor Walk. Tickets cost $5. Children under 8 must be accompanied by an adult. The tour takes about 15 minutes. This route is step-free if the lift is staffed.',
    )
    expect(extraction.soft.price).toBeNull()
    expect(extraction.soft.adultRequired).toBeNull()
    expect(extraction.soft.durationMinutes).toBeNull()
    expect(extraction.soft.access).toBeNull()
  })
  it('makes conflicting canonical/natural or natural/natural hints unknown', () => {
    const extraction = extractRecordFacetHints(
      'Oak Glider. Minimum height: 44 inches. The minimum height is 48 inches. Adult accompaniment is required. Adult accompaniment is not required. Tickets cost USD 5. Tickets cost EUR 5.',
    )
    expect(extraction.soft.minHeightCm).toBeNull()
    expect(extraction.soft.adultRequired).toBeNull()
    expect(extraction.soft.price).toBeNull()
  })
  it('uses natural hints only to prioritize an otherwise unknown finite union', () => {
    const matching = record(
      'place:z-natural',
      'Oak Glider. Riders must be at least 6 years old. Riders must be at least 44 inches tall. The ride lasts 15 minutes. This is a ride.',
    )
    const unknown = record('place:a-unknown', 'A pleasant garden beside the lake.')
    const selected = selectFacetRecords({
      records: [unknown, matching],
      constraints,
      governingKeys: [],
      maxChars: 100,
    })
    expect(selected.selectedKeys).toEqual([matching.key])
    expect(selected.requiredKeys).toContain(unknown.key)
    expect(selected.selectionComplete).toBe(false)
  })
  it('recognizes case-insensitive explicit complete clauses and exact units', () => {
    const hints = extractRecordFacets(body.toUpperCase())
    expect(hints.minAge).toBe(6)
    expect(hints.minHeightCm).toBe(44 * 2.54)
    expect(hints.price).toEqual({ amount: 5, currency: 'USD' })
    expect(classifyFacets(hints, constraints).failures).toEqual([])
  })
  it.each([
    'Minimum height: 44 incheswide',
    'Minimum height: 44 inchworms',
    'Other ride minimum height: 44 inches',
    'Minimum height: 44 inches if an adult accompanies',
    'Minimum height: 44 inches; Minimum height: 48 inches',
    'Minimum height: 44 inches; There is no minimum height',
    'Recommended minimum age: 6 years',
    'Price: USD 5 from noon',
    'Access: not step-free',
    'Duration: 15 minutes; Wait time: 25 minutes',
  ])('keeps ambiguous or unsupported policy text unknown: %s', (text) => {
    expect(Object.values(extractRecordFacets(text)).every((value) => value === null)).toBe(true)
  })
  it('does not confuse negation or optional adult prices with accompaniment', () => {
    expect(extractRecordFacets('Adult accompaniment: not required').adultRequired).toBe(false)
    expect(extractRecordFacets('Adult ticket price: USD 5').adultRequired).toBeNull()
    expect(extractRecordFacets('Included in admission: no').included).toBe(false)
  })
  it('invalidates all exclusion hints for arbitrary unsupported exception prose', () => {
    const text =
      'Minimum age: 8 years; Minimum height: 48 inches. Younger and shorter visitors may participate with a guardian.'
    const row = record('place:guardian-exception', text)
    expect(Object.values(row.facets).every((value) => value === null)).toBe(true)
    expect(classifyFacets(row.facets, constraints).failures).toEqual([])
    expect(
      selectFacetRecords({ records: [row], constraints, governingKeys: [], maxChars: 100 })
        .selectedKeys,
    ).toContain(row.key)
    expect(row.softFacets!.minAge).toBe(8)
    expect(row.softFacets!.minHeightCm).toBe(48 * 2.54)
  })
  it('uses matching anchored clauses to prioritize unknown narrative records without certifying eligibility', () => {
    const matching = record('place:z-match', `${body}; The garden glows at dusk.`)
    const noHints = record('place:a-unknown', 'The garden glows at dusk.')
    expect(Object.values(matching.facets).every((value) => value === null)).toBe(true)
    expect(softFacetPriority(matching.softFacets, constraints)).toBeGreaterThan(
      softFacetPriority(noHints.softFacets, constraints),
    )
    const result = selectFacetRecords({
      records: [noHints, matching],
      constraints,
      governingKeys: [],
      maxChars: 100,
    })
    expect(result.selectedKeys).toEqual([matching.key])
    expect(result.requiredKeys).toContain(noHints.key)
    expect(result.selectionComplete).toBe(false)
    expect(
      facetCoverage({
        selection: result,
        finalPromptKeys: new Set(result.selectedKeys),
        freshCompleteAuthorizedIndex: true,
        hydrationVersionConsistent: true,
      }).complete,
    ).toBe(false)
  })
  it('does not exclude the guardian exception narrative even when two soft hints conflict', () => {
    const row = record(
      'place:exception',
      'Minimum age: 8 years; Minimum height: 48 inches. Younger and shorter visitors may participate with a guardian.',
    )
    expect(classifyFacets(row.softFacets!, constraints).failures).toHaveLength(2)
    expect(classifyFacets(row.facets, constraints).failures).toEqual([])
    expect(
      selectFacetRecords({ records: [row], constraints, governingKeys: [], maxChars: 100 })
        .selectedKeys,
    ).toContain(row.key)
  })
  it.each([
    'Visitors may use the alternative route.',
    'This is a quiet garden.',
    'Ask a host about special arrangements.',
  ])('rejects unsupported prose without a policy keyword: %s', (suffix) => {
    expect(
      Object.values(extractRecordFacets(`${body}; ${suffix}`)).every((value) => value === null),
    ).toBe(true)
  })
  it('rejects conflicting age ranges and parses decimal durations without sentence splitting', () => {
    expect(extractRecordFacets('Minimum age: 12 years; Maximum age: 6 years').minAge).toBeNull()
    expect(extractRecordFacets('Duration: 12.5 minutes.').durationMinutes).toBe(12.5)
  })
  it('retains all compatible, unknown and one-condition near-matches when the union fits', () => {
    const alternatives = [
      ['Minimum age: 6 years', 'Minimum age: 8 years'],
      ['Maximum age: 12 years', 'Maximum age: 6 years'],
      ['Minimum height: 44 inches', 'Minimum height: 48 inches'],
      ['Adult accompaniment: not required', 'Adult accompaniment: required'],
      ['Duration: 15 minutes', 'Duration: 25 minutes'],
      ['Price: USD 5', 'Price: USD 12'],
      ['Access: step-free', 'Access: stairs-only'],
      ['Included in admission: yes', 'Included in admission: no'],
      ['Kind: ride', 'Kind: exhibit'],
    ]
    const rows = [record('knowledge:yes'), record('knowledge:unknown', 'A quiet garden.')]
    alternatives.forEach(([from, to], index) =>
      rows.push(record(`knowledge:boundary-${index}`, body.replace(from!, to!))),
    )
    const result = selectFacetRecords({
      records: rows,
      constraints,
      governingKeys: [],
      maxChars: 5000,
    })
    expect(new Set(result.selectedKeys)).toEqual(new Set(rows.map((row) => row.key)))
    expect(result.selectionComplete).toBe(true)
  })
  it('never silently applies the legacy ten-record or three-place top-k', () => {
    const rows = Array.from({ length: 46 }, (_, index) =>
      record(`${index % 2 ? 'place' : 'knowledge'}:${index}`),
    )
    const result = selectFacetRecords({
      records: rows,
      constraints,
      governingKeys: [],
      maxChars: 4600,
    })
    expect(result.selectedKeys).toHaveLength(46)
  })
  it('unknown extraction cannot remove a previously required candidate', () => {
    const row = record(
      'knowledge:test',
      body.replace('Minimum age: 6 years', 'Minimum age: 8 years'),
    )
    for (const key of Object.keys(row.facets) as Array<keyof typeof row.facets>) {
      const broader = { ...row, facets: { ...row.facets, [key]: null } }
      expect(
        selectFacetRecords({ records: [broader], constraints, governingKeys: [], maxChars: 100 })
          .requiredKeys,
      ).toContain(row.key)
    }
  })
  it('preserves governing topics and marks budget overflow without truncating bodies', () => {
    const rows = [
      record('knowledge:governing', 'General conditions.', 120),
      record('place:a', body, 100),
      record('place:b', body, 100),
    ]
    const result = selectFacetRecords({
      records: rows,
      constraints,
      governingKeys: ['knowledge:governing'],
      maxChars: 250,
    })
    expect(result.selectedKeys[0]).toBe('knowledge:governing')
    expect(result.usedChars).toBe(220)
    expect(result.selectionComplete).toBe(false)
    expect(
      facetCoverage({
        selection: result,
        finalPromptKeys: new Set(result.selectedKeys),
        freshCompleteAuthorizedIndex: true,
        hydrationVersionConsistent: true,
      }).promptRule,
    ).toContain('partial')
  })
  it('invalidates complete coverage after downstream place clipping or hydration changes', () => {
    const selection = selectFacetRecords({
      records: [record('place:a'), record('place:b')],
      constraints,
      governingKeys: [],
      maxChars: 500,
    })
    expect(
      facetCoverage({
        selection,
        finalPromptKeys: new Set(['place:a']),
        freshCompleteAuthorizedIndex: true,
        hydrationVersionConsistent: true,
      }).complete,
    ).toBe(false)
    expect(
      facetCoverage({
        selection,
        finalPromptKeys: new Set(selection.selectedKeys),
        freshCompleteAuthorizedIndex: true,
        hydrationVersionConsistent: false,
      }).complete,
    ).toBe(false)
  })
  it('counts deduplicated recognized statements only when freshness is proven', () => {
    const row = record('knowledge:a')
    const input = {
      records: [row, row, record('knowledge:b', 'A garden.')],
      freshCompleteAuthorizedIndex: true,
      hydrationVersionConsistent: true,
    }
    const lines = recognizedStatementCountLines(input)
    expect(lines).toContain('Records with recognized explicit minHeightCm statement: 1')
    expect(lines.join(' ')).not.toContain('111.76')
    expect(recognizedStatementCountLines({ ...input, hydrationVersionConsistent: false })).toEqual(
      [],
    )
  })
  it('rejects an already over-budget context even when the candidate union is empty', () => {
    expect(() =>
      selectFacetRecords({
        records: [],
        constraints,
        governingKeys: [],
        maxChars: 100,
        alreadyUsedChars: 101,
      }),
    ).toThrow()
  })
  it('does not permit qualifying examples when a mandatory governing policy is absent', () => {
    const selection = selectFacetRecords({
      records: [record('place:a')],
      constraints,
      governingKeys: ['knowledge:policy'],
      maxChars: 100,
    })
    const coverage = facetCoverage({
      selection,
      finalPromptKeys: new Set(selection.selectedKeys),
      freshCompleteAuthorizedIndex: true,
      hydrationVersionConsistent: true,
    })
    expect(coverage.complete).toBe(false)
    expect(coverage.promptRule).toContain('Do not decide eligibility')
  })
})
