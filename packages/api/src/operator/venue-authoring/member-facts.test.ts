import { describe, expect, it } from 'vitest'

import { VenuePackagePayload } from '../../schemas/venue-package'
import { venuePackageAuthoringFindings } from './authoring-checks'

/** All venues and member names in these regressions are fictional. */
const NOW = new Date('2026-10-28T17:00:00Z')
const MEMBER = 'Juniper Grill'
const OVERVIEW = `${MEMBER} — restaurant.\nEast Mall.`

function findings(
  options: {
    overview?: string
    title?: string
    content?: string
    name?: string
    areaName?: string
    place?: boolean
    enabled?: boolean
  } = {},
) {
  const name = options.name ?? MEMBER
  const content = options.content ?? `${name} is a restaurant serving sandwiches.`
  const payload = VenuePackagePayload.parse({
    schemaVersion: 1,
    places: options.place
      ? [{ name, type: 'restaurant', longDescription: content, areaName: options.areaName }]
      : [],
    knowledgeEntries: [
      {
        title: options.title ?? 'Dining overview',
        category: 'Dining',
        content: options.overview ?? OVERVIEW,
      },
      ...(!options.place
        ? [{ title: name, category: 'Dining', content, isEnabled: options.enabled ?? true }]
        : []),
    ],
  })
  return venuePackageAuthoringFindings(payload, NOW).filter(
    (finding) => finding.code === 'MEMBER_FACT_ONLY_IN_OVERVIEW',
  )
}

describe('member location facts belong on the named member', () => {
  it('flags an exact named knowledge member whose area appears only on the next overview line', () => {
    const result = findings()
    expect(result).toHaveLength(1)
    expect(result[0]?.message).toContain(MEMBER)
    expect(result[0]?.message).toContain('East Mall')
    expect(result[0]?.fix).toBeTruthy()
  })

  it('also checks a place member', () => {
    expect(findings({ place: true })).toHaveLength(1)
  })

  it('checks an inline location and deduplicates a repeated fact', () => {
    expect(findings({ overview: `${MEMBER} — restaurant in East Mall.` })).toHaveLength(1)
    expect(findings({ overview: `${OVERVIEW}\n${OVERVIEW}` })).toHaveLength(1)
  })

  it('accepts the same location in member prose', () => {
    expect(findings({ content: `${MEMBER} is a restaurant in the East Mall.` })).toEqual([])
  })

  it('accepts structured areaName without requiring redundant prose', () => {
    expect(findings({ place: true, areaName: 'East Mall' })).toEqual([])
  })

  it('accepts a location label with case and punctuation differences', () => {
    expect(findings({ content: `${MEMBER} serves sandwiches.\nLocation: EAST MALL.` })).toEqual([])
  })

  it('does not treat an unrelated location as the missing area', () => {
    expect(findings({ place: true, areaName: 'West Gate' })).toHaveLength(1)
    expect(findings({ content: `${MEMBER} is beside the pond.` })).toHaveLength(1)
  })

  it('does not attribute a neighboring member name to a different record', () => {
    expect(findings({ name: 'Juniper Grill Annex' })).toEqual([])
  })

  it('does not invent a missing record from an overview', () => {
    expect(findings({ enabled: false })).toEqual([])
  })

  it('does not interpret an ordinary following sentence as an area', () => {
    expect(findings({ overview: `${MEMBER} — restaurant.\nThe gate closes at dusk.` })).toEqual([])
  })

  it('does not cross a heading or bullet boundary to attach an area', () => {
    expect(findings({ overview: `${MEMBER} — restaurant.\n## East Mall` })).toEqual([])
    expect(findings({ overview: `${MEMBER} — restaurant.\n- East Mall.` })).toEqual([])
  })

  it('does not attach a location named in unrelated prose', () => {
    expect(findings({ overview: `The cart is near ${MEMBER}.\nEast Mall.` })).toEqual([])
  })

  it('never borrows a later member location from the same physical line', () => {
    expect(
      findings({ overview: `${MEMBER} — restaurant; Violet Cart — snacks.\nEast Mall.` }),
    ).toEqual([])
    expect(
      findings({
        overview: `${MEMBER} — restaurant in West Wing; Violet Cart — snacks at East Mall.`,
        content: `${MEMBER} is a restaurant in West Wing.`,
      }),
    ).toEqual([])
    expect(
      findings({
        overview: `${MEMBER} — restaurant in West Wing. Violet Cart — snacks at East Mall.`,
        content: `${MEMBER} is a restaurant in West Wing.`,
      }),
    ).toEqual([])
  })

  it('does not demand vague area paraphrases on a mobile member', () => {
    expect(
      findings({
        overview: `${MEMBER} — snack cart.\nvarious areas.`,
        content: `${MEMBER} is a mobile cart around the park.`,
      }),
    ).toEqual([])
    expect(
      findings({
        overview: `${MEMBER} — snack cart at changing locations.`,
        content: `${MEMBER} is a mobile cart around the park.`,
      }),
    ).toEqual([])
  })

  it('leaves ordinary named topics outside the overview check', () => {
    expect(findings({ title: 'Sandwich workshop', overview: OVERVIEW })).toEqual([])
  })

  it('checks enabled v3 updates but skips retired members', () => {
    for (const isEnabled of [true, false]) {
      const payload = VenuePackagePayload.parse({
        schemaVersion: 3,
        places: {},
        knowledgeEntries: {
          create: [
            {
              itemKey: '00000000-0000-4000-8000-000000000001',
              provenance: { sourceType: 'venue_staff', contentOrigin: 'HUMAN_AUTHORED' },
              value: { title: 'Dining overview', category: 'Dining', content: OVERVIEW },
            },
          ],
          update: [
            {
              itemKey: '00000000-0000-4000-8000-000000000002',
              id: 'cmemberrecord0000000000003',
              provenance: { sourceType: 'venue_staff', contentOrigin: 'HUMAN_AUTHORED' },
              value: {
                title: MEMBER,
                category: 'Dining',
                content: `${MEMBER} serves sandwiches.`,
                isEnabled,
              },
            },
          ],
        },
      })
      const result = venuePackageAuthoringFindings(payload, NOW).filter(
        (finding) => finding.code === 'MEMBER_FACT_ONLY_IN_OVERVIEW',
      )
      expect(result).toHaveLength(isEnabled ? 1 : 0)
    }
  })
})
