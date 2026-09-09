import { describe, expect, it, vi } from 'vitest'
import type { SemanticPlace } from '@pathfinder/db'

import {
  expandExplicitGuestPlaceIdentityCandidates,
  hasIncompleteGuestPlaceIdentityDiscovery,
  selectGuestPlaceIdentityContext,
} from './guest-place-identity-discovery'

const place = (id: string, name = 'Case 12'): SemanticPlace => ({
  id,
  name,
  type: 'PLACE',
  itemType: null,
  shortDescription: null,
  longDescription: null,
  lat: null,
  lng: null,
  tags: [],
  areaName: null,
  hours: null,
  photoUrl: null,
  sourceType: 'FOUNDER_PROVIDED',
  sourceName: null,
  sourceUrl: null,
})

describe('guest place identity discovery', () => {
  it('expands exact labels with scoped visibility and preserves seed ranking metadata', async () => {
    const seed = {
      ...place('case-first'),
      shortDescription: 'Older first read',
      distance: 0.04,
      distanceMeters: 12,
    }
    const sibling = place('case-second')
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { ...place('case-first'), shortDescription: 'Current exact-label read' },
        sibling,
      ])
    const result = await expandExplicitGuestPlaceIdentityCandidates({
      reader: { place: { findMany } } as never,
      query: 'Tell me about Case 12',
      tenantId: 'tenant',
      venueId: 'venue',
      includeSecondLayer: true,
      places: [seed],
    })
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant',
          venueId: 'venue',
          isActive: true,
          visibility: { in: ['PUBLIC', 'SECOND_LAYER'] },
          name: { equals: 'Case 12', mode: 'insensitive' },
        },
        orderBy: [{ importanceScore: 'desc' }, { id: 'asc' }],
        take: 65,
      }),
    )
    expect(result.places).toHaveLength(2)
    expect(result.places.find(({ id }) => id === seed.id)).toMatchObject({
      distance: 0.04,
      distanceMeters: 12,
      shortDescription: 'Current exact-label read',
    })
  })

  it('bounds named seed labels and marks an exact-label cap as incomplete', async () => {
    const seeds = Array.from({ length: 10 }, (_, index) => place(`seed-${index}`, `Case ${index}`))
    const findMany = vi
      .fn()
      .mockImplementation(async (args) =>
        Array.from({ length: 65 }, (_, index) =>
          place(`${String(args.where.name.equals)}-${index}`, String(args.where.name.equals)),
        ),
      )
    const result = await expandExplicitGuestPlaceIdentityCandidates({
      reader: { place: { findMany } } as never,
      query: seeds.map(({ name }) => name).join(' and '),
      tenantId: 'tenant',
      venueId: 'venue',
      includeSecondLayer: false,
      places: seeds,
    })
    expect(findMany).toHaveBeenCalledTimes(8)
    expect(result.saturatedLabelKeys.size).toBe(8)
    expect(
      hasIncompleteGuestPlaceIdentityDiscovery({
        query: 'Tell me about Case 0 on the first floor',
        places: result.places,
        saturatedLabelKeys: result.saturatedLabelKeys,
      }),
    ).toBe(true)
    expect(
      hasIncompleteGuestPlaceIdentityDiscovery({
        query: 'Compare Case 0',
        places: result.places,
        saturatedLabelKeys: result.saturatedLabelKeys,
      }),
    ).toBe(false)
  })

  it('does no expansion when the current query does not explicitly name a seed label', async () => {
    const findMany = vi.fn()
    const seed = place('case-first')
    await expect(
      expandExplicitGuestPlaceIdentityCandidates({
        reader: { place: { findMany } } as never,
        query: 'What should I see next?',
        tenantId: 'tenant',
        venueId: 'venue',
        includeSecondLayer: false,
        places: [seed],
      }),
    ).resolves.toEqual({ places: [seed], saturatedLabelKeys: new Set() })
    expect(findMany).not.toHaveBeenCalled()
  })

  it('promotes a location-compatible identity candidate from deep in the expanded set', () => {
    const candidates = Array.from({ length: 65 }, (_, index) => ({
      ...place(`case-${index}`),
      distance: index === 0 ? 0.01 : index,
    }))
    const identity = {
      places: candidates.map((candidate, index) => ({
        id: candidate.id,
        name: candidate.name,
        areaName: null,
        location: index === 63 ? 'East gallery' : `Gallery ${index}`,
        floor: 'First floor',
      })),
      ambiguity: null,
    }
    const selected = selectGuestPlaceIdentityContext({
      query: 'Tell me about Case 12 in East gallery',
      places: candidates,
      identity,
      limit: 8,
    })
    expect(selected[0]?.id).toBe('case-63')
    expect(selected).toHaveLength(1)
    expect(selected.find(({ id }) => id === 'case-0')).toBeUndefined()
  })

  it('preserves original order for non-identity comparisons', () => {
    const places = [place('first'), place('second')]
    expect(
      selectGuestPlaceIdentityContext({
        query: 'Compare Case 12 on both floors',
        places,
        identity: {
          places: places.map((candidate) => ({ ...candidate, location: null, floor: null })),
          ambiguity: null,
        },
      }),
    ).toEqual(places)
  })

  it('can preserve the complete bounded identity expansion while prioritizing a match', () => {
    const places = Array.from({ length: 528 }, (_, index) =>
      place(`place-${index}`, index === 527 ? 'Case 12' : `Other ${index}`),
    )
    const selected = selectGuestPlaceIdentityContext({
      query: 'Tell me about Case 12 in East gallery',
      places,
      identity: {
        places: places.map((candidate, index) => ({
          ...candidate,
          location: index === 527 ? 'East gallery' : null,
          floor: null,
        })),
        ambiguity: null,
      },
      limit: places.length,
    })
    expect(selected).toHaveLength(528)
    expect(selected[0]?.id).toBe('place-527')
  })

  it('keeps unrelated facts while dropping all named facts for conflicting clues', () => {
    const named = [place('east'), place('west')]
    const unrelated = place('cafe', 'Cafe')
    const selected = selectGuestPlaceIdentityContext({
      query: 'Tell me about Case 12 on the first floor in West gallery',
      places: [...named, unrelated],
      identity: {
        places: named.map((candidate, index) => ({
          ...candidate,
          floor: index === 0 ? 'First floor' : 'Second floor',
          location: index === 0 ? 'East gallery' : 'West gallery',
        })),
        ambiguity: {
          requestedName: 'Case 12',
          candidates: [],
          conflictingClues: true,
        },
      },
    })
    expect(selected).toEqual([unrelated])
  })
})
