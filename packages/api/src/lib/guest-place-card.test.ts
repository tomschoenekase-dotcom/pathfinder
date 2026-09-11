import { describe, expect, it } from 'vitest'

import { buildGuestPlaceCards } from './guest-place-card'

const elephantHouse = {
  id: 'place_1',
  name: 'Elephant House',
  type: 'EXHIBIT',
  shortDescription: 'Meet the herd and learn about their care.',
  areaName: 'Savanna Trail',
  hours: '9 AM-4 PM',
  photoUrl: 'https://images.example.com/elephants.jpg',
  lat: 40.7,
  lng: -74,
  distanceMeters: 125,
}

describe('buildGuestPlaceCards', () => {
  it('projects descriptive cards without location or third-party image data', () => {
    const cards = buildGuestPlaceCards({
      assistantResponse: 'The Elephant House is open today.',
      hasLiveLocation: false,
      places: [elephantHouse],
    })

    expect(cards).toEqual([
      {
        id: 'place_1',
        name: 'Elephant House',
        type: 'EXHIBIT',
        shortDescription: 'Meet the herd and learn about their care.',
        areaName: 'Savanna Trail',
        hours: '9 AM-4 PM',
        photoUrl: null,
        distanceMeters: undefined,
        lat: null,
        lng: null,
      },
    ])
  })

  it('preserves live-location data without treating a legacy URL as photo approval', () => {
    const [card] = buildGuestPlaceCards({
      assistantResponse: 'Try Elephant House next.',
      hasLiveLocation: true,
      places: [elephantHouse],
    })

    expect(card).toMatchObject({
      photoUrl: null,
      distanceMeters: 125,
      lat: 40.7,
      lng: -74,
    })

    const [invalid] = buildGuestPlaceCards({
      assistantResponse: 'Try Elephant House next.',
      hasLiveLocation: true,
      places: [{ ...elephantHouse, lat: 95, lng: null, distanceMeters: -1 }],
    })
    expect(invalid).toMatchObject({ distanceMeters: undefined, lat: null, lng: null })
  })

  it('keeps grounded text for a mentioned place and omits unrelated place media', () => {
    const cards = buildGuestPlaceCards({
      assistantResponse: 'Elephant House is open until 4 PM.',
      hasLiveLocation: true,
      places: [
        elephantHouse,
        {
          ...elephantHouse,
          id: 'place_2',
          name: 'Reptile House',
          photoUrl: 'https://images.example.com/internal-review-evidence.jpg',
        },
      ],
    })

    expect(cards).toEqual([
      expect.objectContaining({
        id: 'place_1',
        shortDescription: 'Meet the herd and learn about their care.',
        hours: '9 AM-4 PM',
        photoUrl: null,
      }),
    ])
  })

  it('uses exact name boundaries, preserves retrieval order, and caps cards at three', () => {
    const places = [
      { ...elephantHouse, id: 'p1', name: 'Art' },
      { ...elephantHouse, id: 'p2', name: 'Cafe' },
      { ...elephantHouse, id: 'p3', name: 'Gallery' },
      { ...elephantHouse, id: 'p4', name: 'Atrium' },
      { ...elephantHouse, id: 'p5', name: 'Garden' },
    ]

    const cards = buildGuestPlaceCards({
      assistantResponse:
        'The partial exhibit is separate. Visit Cafe, Gallery, Atrium, and Garden.',
      hasLiveLocation: false,
      places,
    })

    expect(cards.map(({ id }) => id)).toEqual(['p2', 'p3', 'p4'])
  })

  it('normalizes Unicode names and excludes combining-mark and longer-name collisions', () => {
    const cards = buildGuestPlaceCards({
      assistantResponse: 'Skip Á and Caféteria. Visit CAFÉ TERRACE, then 館.',
      hasLiveLocation: false,
      places: [
        { ...elephantHouse, id: 'p1', name: 'Cafe\u0301' },
        { ...elephantHouse, id: 'p2', name: 'Café Terrace' },
        { ...elephantHouse, id: 'p3', name: '館' },
        { ...elephantHouse, id: 'p4', name: 'A' },
      ],
    })

    expect(cards.map(({ id }) => id)).toEqual(['p2', 'p3'])
  })

  it('bounds legacy text without splitting surrogate pairs and rejects unsafe image URLs', () => {
    const [card] = buildGuestPlaceCards({
      assistantResponse: `Visit ${'N'.repeat(199)}😀${'N'.repeat(20)} today.`,
      hasLiveLocation: true,
      places: [
        {
          ...elephantHouse,
          name: `${'N'.repeat(199)}😀${'N'.repeat(20)}`,
          type: 'T'.repeat(140),
          shortDescription: 'D'.repeat(600),
          areaName: 'A'.repeat(250),
          hours: 'H'.repeat(250),
          photoUrl: 'https://operator:secret@images.example.com/pixel.jpg',
        },
      ],
    })

    expect(Array.from(card?.name ?? '')).toHaveLength(200)
    expect(card?.name).toBe(`${'N'.repeat(199)}😀`)
    expect(card?.type).toHaveLength(100)
    expect(card?.shortDescription).toHaveLength(500)
    expect(card?.areaName).toHaveLength(200)
    expect(card?.hours).toHaveLength(200)
    expect(card?.photoUrl).toBeNull()
  })
})
