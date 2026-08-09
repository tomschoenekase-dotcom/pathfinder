import { describe, expect, it } from 'vitest'

import { VenuePackagePayloadV1 } from './venue-package'

describe('VenuePackagePayloadV1', () => {
  it('normalizes the frozen additive import contract', () => {
    expect(
      VenuePackagePayloadV1.parse({
        schemaVersion: 1,
        places: [{ name: 'North Hall', type: 'exhibit' }],
        knowledgeEntries: [{ title: 'Hours', category: 'General', content: 'Open until five.' }],
      }),
    ).toEqual({
      schemaVersion: 1,
      places: [{ name: 'North Hall', type: 'exhibit', tags: [], importanceScore: 0 }],
      knowledgeEntries: [
        { title: 'Hours', category: 'General', content: 'Open until five.', isEnabled: true },
      ],
    })
  })

  it('rejects the legacy media title/description shape and extra synthesis fields', () => {
    expect(
      VenuePackagePayloadV1.safeParse({
        schemaVersion: 1,
        places: [{ title: 'North Hall', type: 'exhibit', description: 'Hall' }],
        knowledgeEntries: [],
        questions: [],
        coverage: {},
      }).success,
    ).toBe(false)
  })

  it('rejects empty, over-limit, and half-coordinate packages', () => {
    expect(
      VenuePackagePayloadV1.safeParse({ schemaVersion: 1, places: [], knowledgeEntries: [] })
        .success,
    ).toBe(false)
    expect(
      VenuePackagePayloadV1.safeParse({
        schemaVersion: 1,
        places: Array.from({ length: 500 }, (_, index) => ({
          name: `Place ${index}`,
          type: 'place',
        })),
        knowledgeEntries: [{ title: 'Extra', category: 'General', content: 'Extra' }],
      }).success,
    ).toBe(false)
    expect(
      VenuePackagePayloadV1.safeParse({
        schemaVersion: 1,
        places: [{ name: 'North Hall', type: 'place', lat: 1 }],
        knowledgeEntries: [],
      }).success,
    ).toBe(false)
  })
})
