import { describe, expect, it } from 'vitest'
import { renderGuestVenueIndex } from './guest-venue-index'

describe('guest venue index', () => {
  const directory = {
    places: [
      {
        name: 'Thunderbolt',
        type: 'ride',
        areaName: 'Ember',
        shortDescription:
          'Thunderbolt is a wooden roller coaster in the Ember realm. It has a long first drop.',
        longDescription: null,
      },
    ],
    knowledge: [
      {
        title: 'Thunderbolt',
        category: 'Ride information',
        content:
          'Thunderbolt is a wooden roller coaster.\nHeight: 48 in to ride\nMade by: Custom Coasters International\nRider requirements: long medical text that stays out of the card',
      },
      {
        title: 'Cinderswing',
        category: 'Ride information',
        content: 'Cinderswing is a swinging pendulum ride.\nHeight: 52 in to ride',
      },
      {
        title: 'Parking',
        category: 'Arrival',
        content: 'Parking is $15 per car in the main lot. The lot opens an hour early.',
      },
    ],
  }
  const index = renderGuestVenueIndex(directory)

  it('gives every record one line with its first sentence', () => {
    expect(index).toContain(
      '- Thunderbolt (Ember): Thunderbolt is a wooden roller coaster in the Ember realm.',
    )
    expect(index).toContain(
      '- Cinderswing: Cinderswing is a swinging pendulum ride. | Height: 52 in to ride',
    )
    expect(index).toContain('- Parking: Parking is $15 per car in the main lot.')
    expect(index).not.toContain('The lot opens an hour early')
  })

  it('carries labelled key facts but not long requirement text', () => {
    expect(index).toContain('Made by: Custom Coasters International')
    expect(index).not.toContain('long medical text')
  })

  it('points a topic about a carded place back to the place instead of repeating it', () => {
    expect(index).toContain('- Thunderbolt: (more about this place) | Height: 48 in to ride')
  })
})
