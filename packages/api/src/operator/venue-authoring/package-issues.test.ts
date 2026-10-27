import { describe, expect, it } from 'vitest'

import { VenuePackagePayload } from '../../schemas/venue-package'
import { explainVenuePackageIssues, withPreviewFix } from './package-issues'

/** Every place and source is fictional. */
const KEY = '7f1c2b9e-7a4d-4e1b-9c2a-5d6e7f8a9b0c'
const PROVENANCE = { sourceType: 'official_website', contentOrigin: 'AI_GENERATED' }

function explain(json: unknown) {
  const parsed = VenuePackagePayload.safeParse(json)
  if (parsed.success) throw new Error('expected the package to be rejected')
  return explainVenuePackageIssues(parsed.error.issues, json)
}

function v3Place(value: Record<string, unknown>) {
  return {
    schemaVersion: 3,
    places: { create: [{ itemKey: KEY, provenance: PROVENANCE, value }] },
    knowledgeEntries: {},
  }
}

describe('explainVenuePackageIssues', () => {
  it('explains a missing or unsupported schemaVersion with a version 3 skeleton', () => {
    for (const json of [{}, { schemaVersion: 4, places: [], knowledgeEntries: [] }]) {
      const [issue] = explain(json)
      expect(issue).toMatchObject({ code: 'SCHEMA_VERSION', path: 'schemaVersion' })
      expect(issue!.fix).toMatch(/schemaVersion 3/u)
      expect(JSON.parse(issue!.example!)).toMatchObject({ schemaVersion: 3 })
    }
  })

  it('names each invented key and where the information belongs', () => {
    const issues = explain({
      schemaVersion: 1,
      places: [{ name: 'Cinderswing', type: 'pendulum ride', latitude: 1, longitude: 2 }],
      knowledgeEntries: [
        {
          title: 'Parking',
          category: 'Visiting',
          content: 'Free.',
          sourceUrl: 'https://example.org',
        },
        { title: 'Pets', category: 'Policies', content: 'Leashed pets only.', notes: 'unsure' },
      ],
    })
    expect(issues.map((issue) => [issue.code, issue.path])).toEqual([
      ['UNKNOWN_FIELD', 'places.0.latitude'],
      ['UNKNOWN_FIELD', 'places.0.longitude'],
      ['UNKNOWN_FIELD', 'knowledgeEntries.0.sourceUrl'],
      ['UNKNOWN_FIELD', 'knowledgeEntries.1.notes'],
    ])
    expect(issues[0]!.example).toBe('"lat": 42.4651, "lng": -92.342')
    expect(issues[2]!.fix).toMatch(/provenance\.sourceUrl/u)
    expect(issues[3]!.fix).toMatch(/every text field reaches visitors/u)
  })

  it('tells a knowledge entry to use title and content, and a place to use name', () => {
    const knowledge = explain({
      schemaVersion: 1,
      places: [],
      knowledgeEntries: [{ name: 'Parking', category: 'Visiting', description: 'Free.' }],
    })
    expect(knowledge.find((issue) => issue.path.endsWith('.name'))!.fix).toMatch(/title/u)
    expect(knowledge.find((issue) => issue.path.endsWith('.description'))!.fix).toMatch(/content/u)
    const place = explain({
      schemaVersion: 1,
      places: [{ title: 'Cinderswing', name: 'Cinderswing', type: 'ride' }],
      knowledgeEntries: [],
    })
    expect(place.find((issue) => issue.path === 'places.0.title')!.fix).toMatch(/use name/u)
  })

  it('shows the operation shape when version 3 lists are plain arrays', () => {
    const issues = explain({
      schemaVersion: 3,
      places: [{ name: 'Cinderswing', type: 'ride' }],
      knowledgeEntries: {},
    })
    expect(issues[0]).toMatchObject({ code: 'WRONG_SHAPE', path: 'places' })
    expect(issues[0]!.example).toMatch(/"itemKey"/u)
  })

  it('lists allowed values, keeps the kind in type, and asks for real UUIDs and ids', () => {
    const issues = explain({
      schemaVersion: 3,
      places: {
        create: [
          {
            itemKey: 'abc',
            provenance: { sourceType: 'web', contentOrigin: 'HUMAN' },
            value: { name: 'Cinderswing', type: 'ride', itemType: 'coaster' },
          },
        ],
        delete: [{ itemKey: KEY, provenance: PROVENANCE, id: 'not an id' }],
      },
      knowledgeEntries: {},
    })
    const by = (code: string) => issues.filter((issue) => issue.code === code)
    expect(by('INVALID_ITEM_KEY')[0]!.path).toBe('places.create.0.itemKey')
    expect(by('NOT_ALLOWED_VALUE').map((issue) => issue.path)).toEqual([
      'places.create.0.provenance.contentOrigin',
      'places.create.0.value.itemType',
    ])
    expect(by('NOT_ALLOWED_VALUE')[0]!.fix).toBe('Use one of: "HUMAN_AUTHORED", "AI_GENERATED".')
    expect(by('NOT_ALLOWED_VALUE')[1]!.fix).toMatch(/Put the specific kind/u)
    expect(by('INVALID_RECORD_ID')[0]!.fix).toMatch(/venues\.list_content/u)
  })

  it('fixes quoted numbers, long text, missing provenance and unpaired coordinates', () => {
    const quoted = explain(v3Place({ name: 'Cinderswing', type: 'ride', lat: '42.46', lng: -92.3 }))
    expect(quoted[0]).toMatchObject({ code: 'WRONG_TYPE', path: 'places.create.0.value.lat' })
    expect(quoted[0]!.example).toBe('"lat": 42.46')

    const long = explain(
      v3Place({ name: 'Cinderswing', type: 'ride', shortDescription: 'x'.repeat(501) }),
    )
    expect(long[0]).toMatchObject({ code: 'TOO_LONG' })
    expect(long[0]!.message).toContain('(501 characters)')
    expect(long[0]!.fix).toMatch(/longDescription/u)

    const missing = explain({
      schemaVersion: 3,
      places: { create: [{ itemKey: KEY, value: { name: 'Cinderswing', type: 'ride' } }] },
      knowledgeEntries: {},
    })
    expect(missing[0]).toMatchObject({ code: 'MISSING_FIELD', path: 'places.create.0.provenance' })

    const pair = explain({
      schemaVersion: 1,
      places: [{ name: 'Cinderswing', type: 'ride', lat: 42 }],
      knowledgeEntries: [],
    })
    expect(pair[0]).toMatchObject({ code: 'COORDINATE_PAIR' })
  })

  it('never quotes more than a short piece of the submitted value', () => {
    const [issue] = explain({
      schemaVersion: 2,
      venue: { aiBehavior: { tonePreset: 'w'.repeat(500) } },
    })
    expect(issue!.message.length).toBeLessThan(120)
    expect(issue!.fix).toContain('"friendly"')
  })

  it('adds fixes to the server preview codes', () => {
    expect(withPreviewFix({ code: 'LOCATION_REQUIRED', path: 'p', message: 'm' }).fix).toMatch(
      /non_location/u,
    )
    expect(withPreviewFix({ code: 'SOMETHING_ELSE', path: 'p', message: 'm' })).not.toHaveProperty(
      'fix',
    )
  })
})
