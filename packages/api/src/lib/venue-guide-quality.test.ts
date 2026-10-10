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
      // The ride topic opens with its source, not with what Thunderbolt is.
      'GUIDE_QUALITY_FIRST_SENTENCE',
      'GUIDE_QUALITY_HEIGHT_LINE',
      'GUIDE_QUALITY_HIDDEN_SENTENCE',
      'GUIDE_QUALITY_HIDDEN_SENTENCE',
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

describe('contract v3 guide-quality warnings', () => {
  const exhibit = (title: string, content: string, category = 'Indoor exhibits') =>
    topic({ title, category, content, path: `knowledgeEntries.${title}` })

  it('asks a Knowledge record about one thing to open by saying what it is', () => {
    const warnings = guideQualityWarnings([
      exhibit('Rigging Loft', 'Recreated workshop.'),
      exhibit('Tide Clock', 'Brass clock models.'),
    ])
    expect(codes(warnings)).toEqual([
      'GUIDE_QUALITY_FIRST_SENTENCE',
      'GUIDE_QUALITY_FIRST_SENTENCE',
    ])
  })

  it('treats initials as part of a name, not a sentence end', () => {
    expect(
      guideQualityWarnings([
        exhibit('H.R. Marlow', 'H.R. Marlow is a powered oyster boat built in 1931.', 'Vessels'),
        place({ name: 'J.T. Pier', shortDescription: 'J.T. Pier is the main fishing pier.' }),
      ]),
    ).toEqual([])
  })

  it('leaves policy, planning, list and overview topics to their own shape', () => {
    expect(
      guideQualityWarnings([
        exhibit('Ride heights', 'Height requirements for every ride.', 'Rides'),
        exhibit('Garden rules', 'Stay on the paths.', 'Gardens'),
        exhibit('Exhibits overview', 'Rigging Loft, Tide Clock.'),
        exhibit('Parking', 'Park in the main lot.', 'Visit planning'),
      ]),
    ).toEqual([])
  })

  it('flags sentences that narrate a source and quotes each one', () => {
    const warnings = guideQualityWarnings([
      exhibit(
        'Model Yachts',
        'Model Yachts is an indoor exhibit of pond yachts. The photographed panel dates the gift to 2011. These plans do not prove installation. A 2009 account connects the yachts to a local club.',
      ),
    ])
    expect(codes(warnings)).toEqual([
      'GUIDE_QUALITY_SOURCE_NARRATION',
      'GUIDE_QUALITY_SOURCE_NARRATION',
      'GUIDE_QUALITY_SOURCE_NARRATION',
    ])
    expect(warnings[0]!.message).toContain('The photographed panel dates the gift to 2011.')
  })

  it('keeps visitor cautions and safety wording without a warning', () => {
    expect(
      guideQualityWarnings([
        exhibit(
          'Harbor Cruise',
          'Harbor Cruise is a 30-minute boat trip. A museum visit does not guarantee a departure. Joining the waitlist does not guarantee a place.',
          'Programs',
        ),
        exhibit(
          'Galley Grill',
          'Galley Grill is a counter-service grill. An item in the allergy binder does not prove it is on today’s menu.',
          'Dining',
        ),
      ]),
    ).toEqual([])
  })

  it('asks an overview to name every other record in its category', () => {
    const warnings = guideQualityWarnings([
      exhibit('Exhibits overview', 'The indoor exhibits are the Rigging Loft and the Tide Clock.'),
      exhibit('Rigging Loft', 'Rigging Loft is a recreated sail loft.'),
      exhibit(
        'Tide Clock indoor exhibit',
        'The Tide Clock indoor exhibit is a brass clock display.',
      ),
      exhibit('Workboats: Models', 'Workboats: Models is a display of workboat models.'),
      exhibit('Signal Flags', 'Signal Flags is a flag display.', 'Outdoor exhibits'),
    ])
    expect(codes(warnings)).toEqual(['GUIDE_QUALITY_OVERVIEW_COVERAGE'])
    expect(warnings[0]!.message).toContain('“Workboats: Models”')
    expect(warnings[0]!.message).not.toContain('Signal Flags')
    expect(warnings[0]!.message).not.toContain('“Tide Clock')
  })
})
