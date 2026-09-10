import { describe, expect, it } from 'vitest'

import {
  guestRecommendationRetrievalLimit,
  partitionGuestRecommendationPlaces,
} from './guest-recommendation-candidates'

const places = [
  { id: 'train', name: 'Train Hall', areaName: 'East wing' },
  { id: 'garden', name: 'Garden', areaName: 'South courtyard' },
  { name: 'Unkeyed feature' },
]

describe('guest recommendation candidates', () => {
  it('filters only exact authorized visited IDs for what-next recommendations', () => {
    const result = partitionGuestRecommendationPlaces({
      query: 'What should I see next?',
      visitContext: { visitedPlaceIds: ['train', 'foreign-place'], interests: ['trains'] },
      places,
    })

    expect(result.recommendationOnly).toBe(true)
    expect(result.excludedVisitedCount).toBe(1)
    expect(result.places).toEqual([places[1], places[2]])
    expect(result.authorizedVisitPlaces).toEqual(places)
    expect(places.map((place) => place.id)).toEqual(['train', 'garden', undefined])
  })

  it('also filters more-like-this requests but ignores only foreign IDs', () => {
    const result = partitionGuestRecommendationPlaces({
      query: 'Could I see more like this?',
      visitContext: { visitedPlaceIds: ['foreign-place'], interests: [] },
      places,
    })

    expect(result).toMatchObject({
      places,
      authorizedVisitPlaces: places,
      recommendationOnly: true,
      excludedVisitedCount: 0,
    })
  })

  it.each([
    'Tell me about Case 12.',
    'What safe exhibit do you recommend?',
    'Can we revisit Train Hall?',
  ])('preserves authorized factual candidates outside recommendation mode: %s', (query) => {
    const result = partitionGuestRecommendationPlaces({
      query,
      visitContext: { visitedPlaceIds: ['train'], interests: ['trains'] },
      places,
    })

    expect(result).toMatchObject({
      places,
      authorizedVisitPlaces: places,
      recommendationOnly: false,
      excludedVisitedCount: 0,
    })
  })

  it.each([
    'Would you recommend Train Hall?',
    'Could you recommend visiting the Train Hall?',
    'Would you recommend Train Hall for kids?',
  ])('preserves an explicitly requested visited place: %s', (query) => {
    expect(
      partitionGuestRecommendationPlaces({
        query,
        places,
        visitContext: { visitedPlaceIds: ['train'], interests: [] },
      }),
    ).toMatchObject({ recommendationOnly: false, places })
  })

  it('uses a named comparison as reference rather than a new recommendation', () => {
    expect(
      partitionGuestRecommendationPlaces({
        query: 'More like Train Hall, please.',
        places,
        visitContext: { visitedPlaceIds: ['train'], interests: [] },
      }),
    ).toMatchObject({ recommendationOnly: true, places: [places[1], places[2]] })
  })

  it('preserves candidates while identity is unresolved', () => {
    expect(
      partitionGuestRecommendationPlaces({
        query: 'What should I see next?',
        visitContext: { visitedPlaceIds: ['train'], interests: [] },
        places,
        identityUnresolved: true,
      }),
    ).toMatchObject({ places, recommendationOnly: false, excludedVisitedCount: 0 })
  })

  it('adds at most the validated unique visited-place bound to recommendation retrieval', () => {
    expect(
      guestRecommendationRetrievalLimit(
        'What should I see next?',
        { visitedPlaceIds: ['train', 'garden'], interests: [] },
        8,
      ),
    ).toBe(10)
    expect(
      guestRecommendationRetrievalLimit(
        'Where is Case 12?',
        { visitedPlaceIds: ['train', 'garden'], interests: [] },
        8,
      ),
    ).toBe(8)
  })

  it('rejects invalid visit payloads and retrieval limits instead of widening a candidate set', () => {
    expect(() =>
      partitionGuestRecommendationPlaces({
        query: 'What should I see next?',
        visitContext: {
          visitedPlaceIds: Array.from({ length: 21 }, (_, index) => `place-${index}`),
          interests: [],
        },
        places,
      }),
    ).toThrow()
    expect(() =>
      guestRecommendationRetrievalLimit('What should I see next?', undefined, -1),
    ).toThrow(RangeError)
  })
})
