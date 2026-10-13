import { describe, expect, it } from 'vitest'
import { collectRideFacts, guestRideFacts } from './guest-ride-facts'

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
