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

  it('preserves kind words in a topic even when the place has its own card', () => {
    expect(index).toContain(
      '- Thunderbolt: Thunderbolt is a wooden roller coaster. | Height: 48 in to ride',
    )
  })
})

describe('guest venue index fact fidelity', () => {
  function render(content: string) {
    return renderGuestVenueIndex({
      places: [],
      knowledge: [{ title: 'Thunderbolt', category: 'Rides', content }],
    })
  }

  it('retains steel, launched and junior kind words and not-a-coaster descriptions', () => {
    for (const kind of [
      'steel launched coaster',
      'wooden junior coaster',
      'pendulum ride, not a coaster',
    ]) {
      expect(render(`Thunderbolt is a ${kind}.`)).toContain(`Thunderbolt is a ${kind}.`)
    }
  })

  it('keeps a 111-degree drop separate from height and speed', () => {
    expect(
      render(
        'Thunderbolt is a steel coaster.\nSize and speed: 111-degree drop; 60 mph\nHeight: 48 in to ride',
      ),
    ).toContain('Size and speed: 111-degree drop; 60 mph | Height: 48 in to ride')
  })

  it('preserves future ride status after the kind sentence', () => {
    expect(
      render('Thunderbolt is a steel coaster. It is not yet open.\nOpened: Planned for 2030'),
    ).toContain('Thunderbolt is a steel coaster. It is not yet open.')
  })

  it('carries every labeled fact independently up to 400 characters', () => {
    const labels = [
      'Made by',
      'Model',
      'Opened',
      'Size and speed',
      'Height',
      'Also called',
      'Alcohol',
    ]
    const index = render(
      [
        'Thunderbolt is a steel coaster.',
        ...labels.map((label) => `${label}: ${'x'.repeat(450)}`),
      ].join('\n'),
    )
    for (const label of labels) {
      const fact = `${label}: ${'x'.repeat(450)}`.slice(0, 400)
      expect(index).toContain(fact)
      expect(index).not.toContain(`${fact}x`)
    }
  })

  it('keeps kinds late in a long first sentence', () => {
    const sentence = `Thunderbolt, ${'with a sweeping route '.repeat(12)}, is a steel launched coaster.`
    expect(render(sentence)).toContain(sentence)
  })

  it('carries labeled facts from place descriptions', () => {
    const index = renderGuestVenueIndex({
      knowledge: [],
      places: [
        {
          name: 'Cinderswing',
          type: 'ride',
          areaName: null,
          shortDescription: 'Cinderswing is a junior coaster.',
          longDescription: 'Model: Junior\nMade by: Ember Engineering',
        },
      ],
    })
    expect(index).toContain(
      'Cinderswing is a junior coaster. | Model: Junior | Made by: Ember Engineering',
    )
  })
})
