import { describe, expect, it } from 'vitest'

import {
  canonicalVenuePackagePayload,
  VENUE_PACKAGE_ITEM_LIMIT,
  VenuePackagePayload,
} from './venue-package'

const knowledge = (index: number) => ({
  title: `Entry ${index}`,
  category: 'FAQ',
  content: `Content ${index}`,
  isEnabled: true,
})

describe('venue package schema', () => {
  it('requires schemaVersion 1 and rejects unsupported root and nested fields', () => {
    expect(
      VenuePackagePayload.safeParse({ places: [], knowledgeEntries: [knowledge(1)] }).success,
    ).toBe(false)
    expect(
      VenuePackagePayload.safeParse({
        schemaVersion: 2,
        places: [],
        knowledgeEntries: [knowledge(1)],
      }).success,
    ).toBe(false)
    const unsupported = VenuePackagePayload.safeParse({
      schemaVersion: 1,
      places: [{ name: 'Lobby', type: 'room', tags: [], importanceScore: 0, audience: 'members' }],
      knowledgeEntries: [{ ...knowledge(1), audience: 'members' }],
      tours: [],
    })
    expect(unsupported.success).toBe(false)
    if (!unsupported.success) {
      expect(unsupported.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining(['', 'places.0', 'knowledgeEntries.0']),
      )
      expect(unsupported.error.issues.every((issue) => issue.message.length > 0)).toBe(true)
    }
  })

  it('enforces one shared 500-item bound', () => {
    const result = VenuePackagePayload.safeParse({
      schemaVersion: 1,
      places: [{ name: 'Lobby', type: 'room', tags: [], importanceScore: 0 }],
      knowledgeEntries: Array.from({ length: VENUE_PACKAGE_ITEM_LIMIT }, (_, index) =>
        knowledge(index),
      ),
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('at most 500'))).toBe(true)
    }
  })

  it('canonicalizes deterministically and binds the venue', () => {
    const payload = VenuePackagePayload.parse({
      schemaVersion: 1,
      places: [],
      knowledgeEntries: [knowledge(1)],
    })
    expect(canonicalVenuePackagePayload('venue_a', payload)).toBe(
      canonicalVenuePackagePayload('venue_a', payload),
    )
    expect(canonicalVenuePackagePayload('venue_a', payload)).not.toBe(
      canonicalVenuePackagePayload('venue_b', payload),
    )
  })
})
