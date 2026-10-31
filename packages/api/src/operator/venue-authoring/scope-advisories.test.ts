import { describe, expect, it } from 'vitest'
import type { VenuePackagePayload } from '../../schemas/venue-package'
import { venuePackageAuthoringFindings } from './authoring-checks'

/** All venues and records here are fictional. These checks inspect already-parsed payloads. */
const now = new Date('2026-10-30T15:00:00Z')
type Place = { name: string; type: string; hours: string }
const pack = (content: string, places: Place[] = [], extraTopics: string[] = []) => ({
  schemaVersion: 1,
  places,
  knowledgeEntries: [content, ...extraTopics].map((text, index) => ({
    title: `Topic ${index}`,
    category: 'Visiting',
    content: text,
  })),
})
const codes = (payload: unknown) =>
  venuePackageAuthoringFindings(payload as VenuePackagePayload, now).map(({ code }) => code)
const hours = '2026 season closed as of October 6, 2026'
const places: Place[] = [
  { name: 'Comet', type: 'ride', hours },
  { name: 'Moonwheel', type: 'ride', hours },
  { name: 'Ember Cafe', type: 'cafe', hours },
  { name: 'Maple Gift Shop', type: 'shop', hours },
]

describe('requirement qualifier scope', () => {
  const ambiguous: string[] = [
    'Height and age requirements are specified for 2025.\nHeight: 42 in minimum\nAge: 6 years minimum\nWeight: 200 lb maximum',
    'Height and weight requirements are listed below.\nHeight: 42 in minimum\nWeight: 200 lb maximum\nAge: 6 years minimum',
    'Height and age requirements apply only when accompanied.\nHeight: 36 in with an adult\nAge: 6 years minimum\nWeight: 200 lb maximum',
    'Cast, limb and transfer requirements below are specified for 2025.\nHeight: 48 in minimum',
    'Casts, limbs and transfers requirements below are specified for 2025.\nHeight: 48 in minimum',
  ]
  it.each(ambiguous)('advises on ambiguous scope: %s', (content) => {
    expect(codes(pack(content))).toContain('AMBIGUOUS_REQUIREMENT_SCOPE')
  })
  const clear: string[] = [
    'Height and age requirements are specified for 2025.\nHeight: 42 in minimum\nAge: 6 years minimum',
    'Casts, limbs and transfers requirements below are specified for 2025.\nCast: must fit restraint\nLimb: must fit restraint\nTransfer: must board independently',
    'Height: minimum 42 in, specified for 2025.\nAge: 6 years minimum',
    'The height rule below applies only when accompanied.\nHeight: 36 in with an adult\nAge: 6 years minimum',
    'Cast, limb and transfer requirements are separate.\nHeight: 48 in minimum, specified for 2025',
    'Height and age requirements are listed below. See staff for details.',
    'Height: 42 in minimum\nAge: 6 years minimum',
  ]
  it.each(clear)('keeps a qualifier on its actual rule: %s', (content) => {
    expect(codes(pack(content))).not.toContain('AMBIGUOUS_REQUIREMENT_SCOPE')
  })
})

describe('copied closure scope', () => {
  it('does not classify a ride by a neighboring restaurant in its directions', () => {
    const members = places.slice(0, 2).concat({
      name: 'Starspinner',
      type: 'ride',
      hours,
      shortDescription: 'A spinning ride beside the pizzeria and gift shop.',
    } as Place)
    expect(codes(pack('The rides are closed for the 2026 season.', members))).not.toContain(
      'COPIED_STATUS_SCOPE',
    )
  })
  it('recognizes a food place by its own type without a food word in its name', () => {
    const members = places.slice(0, 2).concat({ name: 'Ember', type: 'restaurant', hours })
    expect(codes(pack('The rides are closed for the 2026 season.', members))).toContain(
      'COPIED_STATUS_SCOPE',
    )
  })
  it('flags shared broad status on food and shop places', () => {
    expect(
      codes(
        pack(
          'The rides and waterpark are closed for the 2026 season after October 6, 2026.',
          places,
        ),
      ).filter((code) => code === 'COPIED_STATUS_SCOPE'),
    ).toHaveLength(2)
  })
  const guards: Array<[string, Place[], string[]]> = [
    ['The entire park is closed for the 2026 season.', places, []],
    ['The rides are closed for the 2026 season.', places.slice(2), []],
    [
      'The rides are closed for the 2026 season.',
      places.map((place) => ({ ...place, hours: '11am-5pm daily' })),
      [],
    ],
    [
      'The rides are closed for the 2026 season.',
      places.slice(0, 2).concat({ name: 'Starspinner', type: 'ride', hours }),
      [],
    ],
    ['The cafe is closed for the 2026 season.', places, []],
    [
      'The rides are closed for the 2026 season.',
      places.map((place) => ({
        ...place,
        hours: 'Rides closed for the 2026 season; dining hours unknown',
      })),
      [],
    ],
    [
      'The rides are closed for the 2026 season.',
      places,
      ['The entire park is closed for the 2026 season.'],
    ],
  ]
  it.each(guards)('accepts supported or explicitly scoped hours: %s', (content, members, extra) => {
    expect(codes(pack(content, members, extra))).not.toContain('COPIED_STATUS_SCOPE')
  })
  it('recognizes an accented cafe name without an ASCII cafe description', () => {
    const members: Place[] = places
      .slice(0, 2)
      .concat({ name: 'Ember Café', type: 'amenity', hours })
    expect(
      codes(pack('The rides are closed for the 2026 season.', members)).filter(
        (code) => code === 'COPIED_STATUS_SCOPE',
      ),
    ).toHaveLength(1)
  })
  it('ignores inactive v3 updates', () => {
    expect(
      codes({
        schemaVersion: 3,
        places: {
          create: [],
          update: places.map((value) => ({ value: { ...value, isActive: false } })),
        },
        knowledgeEntries: {
          create: [
            { value: { title: 'Hours', content: 'The rides are closed for the 2026 season.' } },
          ],
          update: [],
        },
      }),
    ).not.toContain('COPIED_STATUS_SCOPE')
  })
})
