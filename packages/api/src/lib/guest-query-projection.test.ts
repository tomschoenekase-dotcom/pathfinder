import { describe, expect, it } from 'vitest'
import { projectGuestQuerySource } from './guest-query-projection'
import type { GuestQuerySource } from './guest-query-source'
import { executeGuestStructuredQuery } from './guest-structured-query'

function source(): GuestQuerySource {
  return {
    tenantId: 'tenant-test',
    venueId: 'venue-test',
    version: 'version-1',
    asOf: '2026-10-21T05:00:00.000Z',
    includeSecondLayer: false,
    readPath: 'LEGACY',
    coverage: 'COMPLETE',
    directory: {
      incomplete: false,
      searchVersion: 'version-1',
      places: [
        {
          id: 'same-id',
          name: 'Family Cafe',
          type: 'RESTAURANT',
          itemType: 'RIDE',
          shortDescription: 'Family restroom and free ponchos!',
          longDescription:
            'Also called: Moon Hall. Sells: Vegan bowl. Features: family restroom; step-free. Height: 48 inches; under 10 with an adult.',
          lat: null,
          lng: null,
          tags: ['family restroom', 'vegan', 'step-free'],
          areaName: 'North',
          hours: null,
          photoUrl: null,
          sourceType: 'MANUAL',
          sourceName: null,
          sourceUrl: null,
        },
      ],
      knowledge: [
        {
          id: 'same-id',
          title: 'Family Cafe',
          category: 'VISIT',
          content: 'No cafe in North is closed. All serve vegan bowls.',
          sourceType: 'MANUAL',
          sourceName: null,
          sourceUrl: null,
        },
      ],
    },
  }
}

function run(
  input: GuestQuerySource,
  predicates: Parameters<typeof executeGuestStructuredQuery>[1]['predicates'],
) {
  const snapshot = projectGuestQuerySource(input)
  return executeGuestStructuredQuery(snapshot, {
    tenantId: input.tenantId,
    venueId: input.venueId,
    mode: 'count',
    predicates,
  })
}

describe('guest query projection authority boundary', () => {
  it('rejects native/unverified or incomplete source membership before projection', () => {
    for (const change of [
      { readPath: 'NATIVE' },
      { coverage: 'PARTIAL' },
      { directory: { ...source().directory, incomplete: true } },
      { directory: { ...source().directory, searchVersion: 'old-version' } },
    ])
      expect(() => projectGuestQuerySource({ ...source(), ...change } as never)).toThrow(
        /Unverified/,
      )
  })
  it('preserves scope/version/coverage and distinguishes same raw ID across namespaces', () => {
    const input = source()
    const output = projectGuestQuerySource(input)
    expect(output).toMatchObject({
      tenantId: input.tenantId,
      venueId: input.venueId,
      version: input.version,
      asOf: input.asOf,
      coverage: 'COMPLETE',
    })
    expect(output.records.map((r) => r.key)).toEqual(['place:same-id', 'knowledge:same-id'])
    expect(
      output.records.every((r) => r.tenantId === input.tenantId && r.venueId === input.venueId),
    ).toBe(true)
    expect(run(input, [{ field: 'name', equals: 'Family Cafe' }]).knownMatchCount).toBe(2)
  })

  it('promotes only typed kind/area, keeping itemType distinct and knowledge nonphysical', () => {
    const input = source()
    expect(
      run(input, [
        { field: 'kind', equals: 'RESTAURANT' },
        { field: 'area', equals: 'north' },
      ]).matchingKeys,
    ).toEqual(['place:same-id'])
    expect(run(input, [{ field: 'kind', equals: 'RIDE' }]).knownMatchCount).toBe(0)
    const record = projectGuestQuerySource(input).records[0]!
    expect(record.kind).toEqual({
      state: 'KNOWN',
      value: 'RESTAURANT',
      sources: [{ sourceKey: record.key, fieldPath: 'type' }],
    })
    expect(record.area).toEqual({
      state: 'KNOWN',
      value: 'North',
      sources: [{ sourceKey: record.key, fieldPath: 'areaName' }],
    })
    expect(run(input, [{ field: 'kind', equals: 'KNOWLEDGE' }]).matchingKeys).toEqual([
      'knowledge:same-id',
    ])
  })

  it('does not promote prose, tags, an alias-looking line or title into product/feature/identity facts', () => {
    const input = source()
    for (const value of [true, false]) {
      const result = run(input, [{ field: 'feature', name: 'family restroom', value }])
      expect(result.knownMatchCount).toBe(0)
      expect(result.unknownCandidateCount).toBe(2)
      expect(result.exactEligibleCount).toBeNull()
    }
    expect(run(input, [{ field: 'product', name: 'Vegan bowl' }]).unknownCandidateCount).toBe(2)
    expect(run(input, [{ field: 'name', equals: 'Moon Hall' }]).knownMatchCount).toBe(0)
    expect(
      projectGuestQuerySource(input).records.every(
        (r) => r.aliases === undefined && r.features === undefined,
      ),
    ).toBe(true)
  })

  it('preserves missing/blank kind and area as unknown rather than proving negatives', () => {
    const input = source()
    input.directory.places[0]!.type = '  '
    input.directory.places[0]!.areaName = null
    expect(run(input, [{ field: 'kind', equals: 'RIDE' }])).toMatchObject({
      knownMatchCount: 0,
      unknownCandidateCount: 1,
      exactEligibleCount: null,
    })
    expect(run(input, [{ field: 'area', equals: 'North' }]).unknownCandidateCount).toBe(2)
  })

  it('rejects duplicate within-kind IDs and cross-scope queries at the executor boundary', () => {
    const input = source()
    input.directory.places.push({ ...input.directory.places[0]! })
    expect(() => run(input, [])).toThrow(/duplicate record key/)
    const snapshot = projectGuestQuerySource(source())
    expect(() =>
      executeGuestStructuredQuery(snapshot, {
        tenantId: 'other',
        venueId: snapshot.venueId,
        mode: 'list',
        predicates: [],
      }),
    ).toThrow(/scope mismatch/)
  })

  it('does not mutate source objects or their prose/conditions', () => {
    const input = source()
    const before = structuredClone(input)
    const output = projectGuestQuerySource(input)
    output.records[0]!.name = 'replacement'
    expect(input).toEqual(before)
    expect(input.directory.places[0]!.longDescription).toContain('under 10 with an adult')
  })
})
