import { describe, expect, it } from 'vitest'

import { buildVenueSystemPrompt } from './venue-context'

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

describe('buildVenueSystemPrompt', () => {
  it('contains the venue name', () => {
    const prompt = buildVenueSystemPrompt({ venue, relevantPlaces, userLat: 40.7, userLng: -74.0 })
    expect(prompt).toContain('City Zoo')
  })

  it('contains the venue description', () => {
    const prompt = buildVenueSystemPrompt({ venue, relevantPlaces, userLat: 40.7, userLng: -74.0 })
    expect(prompt).toContain('A wonderful urban zoo.')
  })

  it('contains the relevant place name and distance', () => {
    const prompt = buildVenueSystemPrompt({ venue, relevantPlaces, userLat: 40.7, userLng: -74.0 })
    expect(prompt).toContain('Elephant Enclosure')
    expect(prompt).toContain('42m away')
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

  it('includes user coordinates', () => {
    const prompt = buildVenueSystemPrompt({ venue, relevantPlaces, userLat: 40.7128, userLng: -74.006 })
    expect(prompt).toContain('40.7128')
    expect(prompt).toContain('-74.006')
  })

  it('includes areaName when present', () => {
    const prompt = buildVenueSystemPrompt({ venue, relevantPlaces, userLat: 0, userLng: 0 })
    expect(prompt).toContain('Safari Zone')
  })
})
