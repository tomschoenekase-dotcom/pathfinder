import { describe, expect, it, vi } from 'vitest'

import { projectGuestPlaceIdentity } from './guest-place-identity'

const places = [
  { id: 'first-case-12', name: 'Case 12', areaName: 'North gallery' },
  { id: 'second-case-12', name: 'Case 12', areaName: 'South gallery' },
]
const duplicateLocationRows = [
  {
    primaryPlaceId: 'first-case-12',
    displayName: 'North gallery',
    floor: {
      name: 'First floor',
      stableKey: 'first-floor',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
    },
  },
  {
    primaryPlaceId: 'second-case-12',
    displayName: 'South gallery',
    floor: {
      name: 'Second floor',
      stableKey: 'second-floor',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
    },
  },
]

describe('projectGuestPlaceIdentity', () => {
  it('asks for a floor only for an identity question with a duplicate full label', async () => {
    const findMany = vi.fn().mockResolvedValue(duplicateLocationRows)
    const result = await projectGuestPlaceIdentity({
      reader: { venueLocation: { findMany } } as never,
      query: 'Tell me about Case 12',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      places,
    })
    expect(result.ambiguity?.candidates).toHaveLength(2)
    expect(result.places.map((place) => place.floor)).toEqual(['First floor', 'Second floor'])
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          isActive: true,
          visibility: 'PUBLIC',
          primaryPlaceId: { in: ['first-case-12', 'second-case-12'] },
        }),
      }),
    )
  })

  it('keeps a literal floor label in the projection while avoiding a clarification', async () => {
    const findMany = vi.fn().mockResolvedValue(duplicateLocationRows)
    const result = await projectGuestPlaceIdentity({
      reader: { venueLocation: { findMany } } as never,
      query: 'Tell me about Case 12 on the first floor',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      places,
    })
    expect(result.ambiguity).toBeNull()
    expect(result.places[0]?.floor).toBe('First floor')
  })

  it('keeps a duplicate with an unknown floor in the clarification candidates', async () => {
    const findMany = vi.fn().mockResolvedValue([duplicateLocationRows[0]])
    const result = await projectGuestPlaceIdentity({
      reader: { venueLocation: { findMany } } as never,
      query: 'Tell me about Case 12 on the first floor',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      places,
    })
    expect(result.ambiguity?.candidates.map(({ id }) => id)).toEqual([
      'first-case-12',
      'second-case-12',
    ])
    expect(result.ambiguity?.candidates[1]).toMatchObject({
      floor: null,
      location: 'South gallery',
    })
  })

  it('excludes only duplicates whose recorded floor contradicts the supplied floor', async () => {
    const findMany = vi.fn().mockResolvedValue(duplicateLocationRows)
    const result = await projectGuestPlaceIdentity({
      reader: { venueLocation: { findMany } } as never,
      query: 'Tell me about Case 12 on the first floor',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      places: [...places, { id: 'unknown-case-12', name: 'Case 12', areaName: null }],
    })
    expect(result.ambiguity?.candidates.map(({ id }) => id)).toEqual([
      'first-case-12',
      'unknown-case-12',
    ])
  })

  it('does not trigger for distinct names or weak clues, and preserves a nonduplicate null area', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    const reader = { venueLocation: { findMany } } as never
    await expect(
      projectGuestPlaceIdentity({
        reader,
        query: 'Compare Case 12 and Case 13',
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        includeSecondLayer: false,
        places: [places[0]!, { id: 'case-13', name: 'Case 13', areaName: null }],
      }),
    ).resolves.toMatchObject({ ambiguity: null })
    await expect(
      projectGuestPlaceIdentity({
        reader,
        query: 'What is that massive house?',
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        includeSecondLayer: false,
        places,
      }),
    ).resolves.toMatchObject({ ambiguity: null })
    await expect(
      projectGuestPlaceIdentity({
        reader,
        query: 'Tell me about the atrium',
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        includeSecondLayer: false,
        places: [{ id: 'atrium', name: 'Atrium', areaName: null }],
      }),
    ).resolves.toEqual({
      ambiguity: null,
      places: [{ id: 'atrium', name: 'Atrium', areaName: null, location: null, floor: null }],
    })
    expect(findMany).not.toHaveBeenCalled()
  })

  it('enriches duplicate labels for comparison and recommendation requests without an ambiguity rule', async () => {
    const findMany = vi.fn().mockResolvedValue(duplicateLocationRows)
    const reader = { venueLocation: { findMany } } as never
    for (const query of [
      'Which Case 12 should I see next?',
      'What should I see after Case 12?',
      'Compare Case 12 on both floors',
    ]) {
      const result = await projectGuestPlaceIdentity({
        reader,
        query,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        includeSecondLayer: false,
        places,
      })
      expect(result.ambiguity).toBeNull()
      expect(result.places.map((place) => place.floor)).toEqual(['First floor', 'Second floor'])
    }
    expect(findMany).toHaveBeenCalledTimes(3)
  })

  it('allows only public and second-layer locations when second-layer access is established', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    await projectGuestPlaceIdentity({
      reader: { venueLocation: { findMany } } as never,
      query: 'Tell me about Case 12',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: true,
      places,
    })
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          visibility: { in: ['PUBLIC', 'SECOND_LAYER'] },
        }),
      }),
    )
  })
})
