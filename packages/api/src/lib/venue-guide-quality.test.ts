import { describe, expect, it } from 'vitest'

import { guideQualityWarnings, venuePackageGuideQualityWarnings } from './venue-guide-quality'

const place = (overrides: Record<string, unknown> = {}) => ({
  kind: 'place' as const,
  path: 'places.0',
  name: 'Thunderbolt',
  type: 'ride',
  itemType: 'activity',
  shortDescription: 'Thunderbolt is a launched roller coaster in the Ember realm.',
  longDescription:
    'Thunderbolt is a launched roller coaster in the Ember realm. Look for the cave entrance under the THUNDERBOLT banner.',
  ...overrides,
})
const topic = (overrides: Record<string, unknown> = {}) => ({
  kind: 'knowledge' as const,
  path: 'knowledgeEntries.0',
  title: 'Thunderbolt',
  category: 'Ride information',
  content: 'Thunderbolt is a launched roller coaster in the Ember realm.\n\nHeight: 48 in to ride',
  ...overrides,
})
const codes = (w: ReturnType<typeof guideQualityWarnings>) => w.map((x) => x.code).sort()

describe('guide-quality warnings', () => {
  it('accepts records written to the standard', () => {
    expect(guideQualityWarnings([place(), topic()])).toEqual([])
  })

  it('flags research notes, record voice, research labels and source links', () => {
    const warnings = guideQualityWarnings([
      place({
        name: 'Thunderbolt (ride feature anchor)',
        shortDescription:
          'Approximate ride-feature anchor; this pin does not establish an exact door. Launched coaster.',
      }),
      topic({
        title: 'Thunderbolt: visitor information',
        content:
          'The current official ride page lists 48 inches. Sources: https://a.example/x https://b.example/y',
      }),
    ])
    expect(codes(warnings)).toEqual([
      'GUIDE_QUALITY_FIRST_SENTENCE',
      'GUIDE_QUALITY_HEIGHT_LINE',
      'GUIDE_QUALITY_NAME_LABEL',
      'GUIDE_QUALITY_RESEARCH_TEXT',
      'GUIDE_QUALITY_RESEARCH_TEXT',
      'GUIDE_QUALITY_TITLE',
      'GUIDE_QUALITY_URL_IN_TEXT',
    ])
    expect(warnings.every((w) => w.message.includes('Writing guide records'))).toBe(true)
  })

  it('allows one visitor-usable link in a tickets topic and accepts exact height charts', () => {
    expect(
      guideQualityWarnings([
        topic({
          title: 'Tickets and passes',
          category: 'Tickets',
          content: 'Buy tickets online at https://park.example/tickets/.',
        }),
        topic({
          title: 'Ride heights',
          category: 'Ride requirements',
          content:
            'Thunderbolt: 48 in to ride\nSkyhook: 52 in to ride\nTiny Train: 36 in with an adult; 42 in alone',
        }),
      ]),
    ).toEqual([])
  })

  it('reads every created and updated record in a schemaVersion 3 package with exact paths', () => {
    const warnings = venuePackageGuideQualityWarnings({
      schemaVersion: 3,
      places: {
        create: [],
        update: [
          {
            value: {
              name: 'Gate',
              type: 'entrance',
              itemType: null,
              shortDescription: 'Researched approximate TEST pin.',
              longDescription: null,
            },
          },
        ],
      },
      knowledgeEntries: {
        create: [
          { value: { title: 'Hours?', category: 'Hours', content: 'Open 10am-6pm daily.' } },
        ],
        update: [],
      },
    })
    expect(warnings.map((w) => w.path).sort()).toEqual([
      'knowledgeEntries.create.0.value.title',
      'places.update.0.value.shortDescription',
      'places.update.0.value.shortDescription',
    ])
  })
})
