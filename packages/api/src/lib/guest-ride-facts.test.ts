import { describe, expect, it } from 'vitest'
import { collectRideFacts, guestRideFacts, hasDocumentedRideMaker } from './guest-ride-facts'

const record = (title: string, content: string) => ({ title, category: 'Rides', content })

const emberwild = {
  knowledge: [
    record(
      'Thunderbolt',
      'Thunderbolt is a wooden roller coaster in the Ember realm.\nHeight: 48 in to ride\nMade by: Custom Coasters International\nSize and speed: about 90 feet tall; about 52 mph',
    ),
    record(
      'Cinderswing',
      'Cinderswing is a swinging pendulum ride, not a roller coaster.\nHeight: 52 in to ride\nSize: the ride may not accommodate larger guests',
    ),
    record(
      'Glowworm',
      'Glowworm is a junior roller coaster for kids.\nHeight: 36 in with an adult\nMade by: E&F Miler Industries',
    ),
    record(
      'Skyfang',
      'Skyfang is a future family roller coaster, announced for 2027.\nMade by: Rocky Mountain Construction',
    ),
    record('Dining overview', 'Emberwild Park has four places to eat.'),
  ],
}

describe('guest ride facts', () => {
  it('preserves and excludes known operating status labels from current coasters', () => {
    for (const label of ['Operating status', 'Ride status']) {
      const facts = collectRideFacts({
        knowledge: [
          record(
            'Comet',
            `Comet is a steel coaster.\n${label}: Permanently closed.\nMade by: Ember Works`,
          ),
        ],
      })
      expect(facts[0]!.isCoaster).toBe(false)
      expect(facts[0]!.lines).toContain(`${label}: Permanently closed.`)
    }
  })
  it('withholds a maker verdict for negated or unknown maker wording', () => {
    const directory = {
      knowledge: [
        record('Comet', 'Comet is a steel coaster.\nMade by: Not Intamin; maker unknown'),
      ],
    }
    const block = guestRideFacts({ question: 'Any Intamin rides?', directory })!
    expect(block).toContain('is unknown')
    expect(block).not.toContain('name Intamin as maker')
  })
  it('does not infer complete coaster absence from an empty coaster inventory', () => {
    const block = guestRideFacts({
      question: 'Any Intamin rides?',
      directory: {
        knowledge: [
          record('Spinwheel', 'Spinwheel is not a roller coaster.\nMade by: Fictional Works'),
        ],
      },
    })!
    expect(block).not.toContain('every roller coaster names a different maker')
    expect(block).toContain('no current coaster records')
  })
  it('qualifies a closed ride maker match as unavailable', () => {
    const block = guestRideFacts({
      question: 'Any Intamin rides?',
      directory: {
        knowledge: [
          record(
            'Comet',
            'Comet is a steel coaster.\nStatus: permanently closed\nMade by: Intamin',
          ),
        ],
      },
    })!
    expect(block).toContain('Comet (not currently available per its record)')
  })
  it('does not treat a placeholder maker as proof of a different maker', () => {
    const directory = {
      knowledge: [record('Comet', 'Comet is a steel coaster.\nMade by: Unknown')],
    }
    expect(guestRideFacts({ question: 'Any Intamin rides?', directory })).toContain('is unknown')
  })
  it('retains a named ride beyond the forty-record cue budget', () => {
    const directory = {
      knowledge: Array.from({ length: 55 }, (_, i) =>
        record(
          `Comet ${i}`,
          `Comet ${i} is a steel coaster.\nMade by: Ember Works\nSpeed: ${i + 20} mph`,
        ),
      ),
    }
    expect(guestRideFacts({ question: 'How fast is Comet 54?', directory })).toContain(
      'Speed: 74 mph',
    )
    directory.knowledge[54]!.title = 'Comet 54: ride facts'
    expect(guestRideFacts({ question: 'How fast is Comet 54?', directory })).toContain(
      'Speed: 74 mph',
    )
    directory.knowledge[54]!.content += '\nAlso called: Meteor'
    expect(guestRideFacts({ question: 'How fast is Meteor?', directory })).toContain(
      'Speed: 74 mph',
    )
  })
  it('keeps a current coaster with a former name in its history', () => {
    expect(
      collectRideFacts({
        knowledge: [
          record(
            'Comet',
            'Comet is a steel roller coaster. Its former name was Meteor.\nMade by: Ember Works',
          ),
        ],
      })[0]!.isCoaster,
    ).toBe(true)
  })
  it('does not mistake queue plans or future expansion for ride closure', () => {
    for (const plan of [
      'A new queue is planned for next season.',
      'A future expansion will add a queue.',
    ]) {
      expect(
        collectRideFacts({
          knowledge: [
            record(
              'Comet',
              `Comet is a steel roller coaster. It is open now. ${plan}\nMade by: Ember Works`,
            ),
          ],
        })[0]!.isCoaster,
      ).toBe(true)
    }
  })
  it('retains both records for a colliding alias without choosing a maker', () => {
    const directory = {
      knowledge: [
        record('Comet', 'Comet is a steel coaster.\nAlso called: Meteor\nMade by: Ember Works'),
        record('Orbit', 'Orbit is a wooden coaster.\nAlso called: Meteor\nMade by: Ash Works'),
      ],
    }
    const block = guestRideFacts({ question: 'Who made Meteor?', directory })!
    expect(block).toContain('Comet')
    expect(block).toContain('Orbit')
    expect(block).not.toContain('MAKER CHECK')
  })

  // An operating coaster was dropped from coaster and maker answers because its record mentioned
  // another, former ride or a weather pause.
  it('keeps a current coaster whose record mentions other lifecycles', () => {
    for (const content of [
      `Pinwheel is a compact family steel coaster. It is distinct from the former Meteor Coaster.
Made by: Ember Works`,
      `Pinwheel is a steel coaster built on the former quarry floor.
Made by: Ember Works`,
      `Pinwheel is a steel coaster.
The ride is not open during lightning.
Made by: Ember Works`,
      `Pinwheel is a steel coaster.
Status: Open (closed during storms)
Made by: Ember Works`,
    ])
      expect(collectRideFacts({ knowledge: [record('Pinwheel', content)] })[0]!.isCoaster).toBe(
        true,
      )
  })
  it('keeps a maker whose description contains "not"', () => {
    expect(hasDocumentedRideMaker('Ember Works, a custom design, not an off-the-shelf model')).toBe(
      true,
    )
    expect(hasDocumentedRideMaker('not recorded')).toBe(false)
    expect(hasDocumentedRideMaker('Maker unknown')).toBe(false)
  })

  it('does not call closed or unopened coasters current', () => {
    const directory = {
      knowledge: [
        record(
          'Tomorrow',
          'Tomorrow is a steel coaster. It is not yet open.\nMade by: Ember Works',
        ),
        record(
          'Yesterday',
          'Yesterday is a wooden coaster.\nStatus: permanently closed\nMade by: Ember Works',
        ),
      ],
    }
    expect(collectRideFacts(directory).filter((f) => f.isCoaster)).toEqual([])
  })
  it('collects labelled fact lines and skips rider-fit size notes', () => {
    const facts = collectRideFacts(emberwild)
    const thunderbolt = facts.find((f) => f.ride === 'Thunderbolt')!
    expect(thunderbolt.makers).toEqual(['Custom Coasters International'])
    expect(thunderbolt.lines).toContain('Size and speed: about 90 feet tall; about 52 mph')
    expect(facts.find((f) => f.ride === 'Cinderswing')?.lines ?? []).toEqual([])
  })

  it('counts only current coasters: not a "not a coaster" ride and not a future one', () => {
    const coasters = collectRideFacts(emberwild)
      .filter((f) => f.isCoaster)
      .map((f) => f.ride)
    expect(coasters).toEqual(['Thunderbolt', 'Glowworm'])
  })

  it('stays silent for questions that are not about ride facts', () => {
    expect(guestRideFacts({ question: 'where can I get food', directory: emberwild })).toBeNull()
  })

  it('concludes "none" only when every coaster names a different maker', () => {
    const block = guestRideFacts({ question: 'any Intamin rides here?', directory: emberwild })!
    expect(block).toContain('Every roller coaster record names its maker or designer.')
    expect(block).toContain("none of the park's roller coasters are by Intamin")
  })

  it('keeps an unknown maker unknown', () => {
    const partial = {
      knowledge: [
        ...emberwild.knowledge,
        record('Riptide', 'Riptide is a launched roller coaster.\nHeight: 54 in to ride'),
      ],
    }
    const block = guestRideFacts({
      question: 'does intamin have any rides here?',
      directory: partial,
    })!
    expect(block).toContain('Roller coasters with no maker on record: Riptide.')
    expect(block).toContain('is unknown')
    expect(block).not.toContain('none of the park')
  })

  it('names the matching rides for a maker the records use', () => {
    const block = guestRideFacts({
      question: 'did custom coasters build anything here',
      directory: emberwild,
    })!
    expect(block).toContain('MAKER CHECK for Custom Coasters International: Thunderbolt')
  })

  it('answers stat questions with the record wording', () => {
    const block = guestRideFacts({
      question: 'how tall and fast is thunderbolt',
      directory: emberwild,
    })!
    expect(block).toContain('about 90 feet tall; about 52 mph')
  })
})
