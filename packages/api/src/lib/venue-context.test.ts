import { describe, expect, it } from 'vitest'

import { buildVenueSystemPrompt, formatDistance } from './venue-context'

const venue = {
  name: 'City Zoo',
  description: 'A wonderful urban zoo.',
  category: 'zoo',
  guideNotes: null,
}

const relevantPlaces = [
  {
    name: 'Elephant Enclosure',
    type: 'attraction',
    shortDescription: 'Home to three Asian elephants.',
    longDescription: null,
    distanceMeters: 42,
    areaName: 'Safari Zone',
    tags: ['animals', 'family'],
    hours: '9am–5pm',
  },
  {
    name: 'Restrooms A',
    type: 'restroom',
    shortDescription: null,
    longDescription: null,
    distanceMeters: 15,
    areaName: null,
    tags: [],
    hours: null,
  },
]

describe('formatDistance', () => {
  it('returns "right nearby" for very short distances', () => {
    expect(formatDistance(5)).toBe('right nearby')
    expect(formatDistance(18)).toBe('right nearby') // 18m = ~59ft, just under 60ft threshold
  })

  it('returns rounded feet for short distances', () => {
    expect(formatDistance(42)).toBe('about 150 feet away') // 42m = ~138ft → rounds to 150
    expect(formatDistance(100)).toBe('about 325 feet away') // 100m = ~328ft → rounds to 325
  })

  it('returns minutes walk for distances over 500ft', () => {
    expect(formatDistance(400)).toBe('about a 5-minute walk') // 400m / 80 = 5min
    expect(formatDistance(160)).toBe('about a 2-minute walk') // 160m / 80 = 2min
  })
})

describe('buildVenueSystemPrompt', () => {
  it('contains the venue name', () => {
    const prompt = buildVenueSystemPrompt({ venue, relevantPlaces, userLat: 40.7, userLng: -74.0 })
    expect(prompt).toContain('City Zoo')
  })

  it('contains the venue description', () => {
    const prompt = buildVenueSystemPrompt({ venue, relevantPlaces, userLat: 40.7, userLng: -74.0 })
    expect(prompt).toContain('A wonderful urban zoo.')
  })

  it('contains the relevant place name and natural-language distance', () => {
    const prompt = buildVenueSystemPrompt({ venue, relevantPlaces, userLat: 40.7, userLng: -74.0 })
    expect(prompt).toContain('Elephant Enclosure')
    // 42m = ~138 feet → rounded to nearest 25 → "about 150 feet away"
    expect(prompt).toContain('about 150 feet away')
    // 15m = ~49 feet → under 60ft threshold → "right nearby"
    expect(prompt).toContain('right nearby')
  })

  it('falls back to default description when venue.description is null', () => {
    const prompt = buildVenueSystemPrompt({
      venue: { ...venue, description: null },
      relevantPlaces,
      userLat: 0,
      userLng: 0,
    })
    expect(prompt).toContain('A venue with many things to explore.')
  })

  it('handles empty places gracefully', () => {
    const prompt = buildVenueSystemPrompt({
      venue,
      relevantPlaces: [],
      userLat: 0,
      userLng: 0,
    })
    expect(prompt).toContain('No specific points of interest have been configured yet.')
  })

  it('does not contain importanceScore or tenantId', () => {
    const prompt = buildVenueSystemPrompt({ venue, relevantPlaces, userLat: 0, userLng: 0 })
    expect(prompt).not.toContain('importanceScore')
    expect(prompt).not.toContain('tenantId')
  })

  it('does not expose raw coordinates in the prompt', () => {
    const prompt = buildVenueSystemPrompt({
      venue,
      relevantPlaces,
      userLat: 40.7128,
      userLng: -74.006,
    })
    expect(prompt).not.toContain('40.7128')
    expect(prompt).not.toContain('-74.006')
  })

  it('includes areaName when present', () => {
    const prompt = buildVenueSystemPrompt({ venue, relevantPlaces, userLat: 0, userLng: 0 })
    expect(prompt).toContain('Safari Zone')
  })
})
