import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  generateVenueQuestions,
  runVenueQuestionCli,
  type VenueQuestionInput,
} from '../../scripts/generate-venue-questions'

const input: VenueQuestionInput = {
  slug: 'emberwild',
  knowledge: [
    {
      title: 'Thunderbolt',
      category: 'Rides',
      content:
        'Thunderbolt is a steel launched coaster.\nMade by: Ember Engineering\nSize and speed: 120 ft tall; 60 mph; 111-degree drop\nHeight: 48 in to ride',
    },
    {
      title: 'Cinderswing',
      category: 'Rides',
      content:
        'Cinderswing is a wooden junior coaster.\nMade by: Ash Works\nSize and speed: 40 ft tall; 25 mph',
    },
    {
      title: 'Tomorrow',
      category: 'Rides',
      content: 'Tomorrow is a steel coaster. It is not yet open.',
    },
    { title: 'Pendulum', category: 'Rides', content: 'Pendulum is a thrill ride, not a coaster.' },
    {
      title: 'Ember Cafe',
      category: 'Dining',
      content:
        'Ember Cafe serves lunch.\nMenu: Burgers and fries\nAlcohol: Beer and wine sold here',
    },
    {
      title: 'Park facts',
      category: 'General',
      content: 'Emberwild Park does not publish attendance.',
    },
  ],
}
function expectedFor(question: string, source = input) {
  const generated = generateVenueQuestions(source)
  const entry = generated.cases.find((entry) => entry.turns[0] === question)
  expect(entry, question).toBeDefined()
  return generated.truth[entry!.id]!
}

describe('venue question generator', () => {
  it('treats negated maker wording as unknown rather than maker presence', () => {
    const source = {
      slug: 'emberwild',
      knowledge: [
        {
          title: 'Comet',
          category: 'Rides',
          content: 'Comet is a steel coaster.\nMade by: Not Intamin; maker unknown',
        },
      ],
    }
    expect(expectedFor('Who made Comet?', source)).toContain('not documented')
    expect(
      generateVenueQuestions(source).cases.some((entry) => entry.tags.includes('maker-presence')),
    ).toBe(false)
  })
  it('does not remove an operating coaster because a queue is planned', () => {
    expect(
      expectedFor('How many coasters are here?', {
        slug: 'emberwild',
        knowledge: [
          {
            title: 'Comet',
            category: 'Rides',
            content:
              'Comet is a steel roller coaster. It is open now. A new queue is planned for next season.\nMade by: Ember Works',
          },
        ],
      }),
    ).toContain('1 documented')
  })
  it('keeps a current coaster when its narrative documents a former name', () => {
    expect(
      expectedFor('How many coasters are here?', {
        slug: 'emberwild',
        knowledge: [
          {
            title: 'Comet',
            category: 'Rides',
            content: 'Comet is a steel coaster. Its former name was Meteor.',
          },
        ],
      }),
    ).toContain('1 documented')
  })
  it('treats unknown maker labels as missing and status closures as non-current', () => {
    const generated = generateVenueQuestions({
      slug: 'emberwild',
      knowledge: [
        {
          title: 'Comet',
          category: 'Rides',
          content: 'Comet is a steel coaster.\nMade by: Unknown',
        },
        {
          title: 'Yesterday',
          category: 'Rides',
          content: 'Yesterday is a steel coaster.\nStatus: permanently closed\nMade by: Ash Works',
        },
      ],
    })
    expect(
      generated.truth[generated.cases.find((entry) => entry.tags.includes('maker-absence'))!.id],
    ).toContain('maker unknown for Comet')
    expect(
      generated.truth[generated.cases.find((entry) => entry.tags.includes('coaster-count'))!.id],
    ).toContain('1 documented')
  })
  it('produces deterministic lab-compatible cases and truth in the requested bounds', () => {
    const generated = generateVenueQuestions(input)
    expect(generated).toEqual(
      generateVenueQuestions({ ...input, knowledge: [...input.knowledge].reverse() }),
    )
    expect(generated.cases.length).toBeGreaterThanOrEqual(20)
    expect(generated.cases.length).toBeLessThanOrEqual(40)
    expect(new Set(generated.cases.map((entry) => entry.turns[0])).size).toBe(
      generated.cases.length,
    )
    for (const entry of generated.cases) {
      expect(entry).toMatchObject({
        venue: 'emberwild',
        turns: [expect.any(String)],
        at: expect.any(String),
        tags: [expect.any(String)],
      })
      expect(generated.truth[entry.id]).toEqual(expect.any(String))
    }
    expect(generated.cases.filter((entry) => entry.tags.includes('casual'))).toHaveLength(5)
  })

  it('grounds maker, count, speed, food, alcohol and unpublished attendance questions', () => {
    expect(expectedFor('Who made Thunderbolt?')).toBe('Made by: Ember Engineering')
    expect(expectedFor('Any Ash Works rides here?')).toContain('Cinderswing: Made by: Ash Works')
    expect(expectedFor('Any Intamin rides here?')).toContain('No record names Intamin')
    expect(expectedFor('How tall and fast is Thunderbolt?')).toBe(
      'Size and speed: 120 ft tall; 60 mph; 111-degree drop',
    )
    expect(expectedFor('How many coasters are here?')).toContain('2 documented current coasters')
    expect(expectedFor('What is the fastest coaster?')).toContain('Thunderbolt')
    expect(expectedFor('What is the fastest coaster?')).not.toContain('Cinderswing')
    expect(expectedFor('Where can I get food?')).toContain('Burgers and fries')
    expect(expectedFor('Can I get a beer?')).toContain('Beer and wine sold here')
    expect(expectedFor('How many people come here a year?')).not.toMatch(/\d/)
  })

  it('does not confuse drops, rider height or missing speed with ride size', () => {
    for (const size of [
      'Size and speed: 111-degree drop; 60 mph',
      'Size and speed: 111 ft drop; 60 mph',
      'Size and speed: 120 ft tall',
    ]) {
      const generated = generateVenueQuestions({
        ...input,
        knowledge: [
          {
            title: 'Thunderbolt',
            category: 'Rides',
            content: `Thunderbolt is a steel coaster.\n${size}\nHeight: 48 in to ride`,
          },
        ],
      })
      expect(generated.cases.some((entry) => entry.tags.includes('ride-size'))).toBe(false)
      expect(
        generated.truth[generated.cases.find((entry) => entry.tags.includes('maker-absence'))!.id],
      ).toContain('maker unknown')
    }
  })

  it('works for sparse venues without inventing facts', () => {
    const generated = generateVenueQuestions({ slug: 'emberwild', knowledge: [] })
    expect(generated.cases).toHaveLength(20)
    expect(expectedFor('Can I get a beer?', { slug: 'emberwild', knowledge: [] })).toContain(
      'not documented',
    )
    expect(
      expectedFor('How many people come here a year?', { slug: 'emberwild', knowledge: [] }),
    ).toContain('Do not give a number')
  })

  it('ignores disabled/private records and inactive places', () => {
    const generated = generateVenueQuestions({
      slug: 'emberwild',
      knowledge: [
        { ...input.knowledge[0]!, visibility: 'PRIVATE' },
        { ...input.knowledge[1]!, isEnabled: false },
      ],
      places: [{ name: 'Hidden Cafe', type: 'dining', isActive: false }],
    })
    expect(JSON.stringify(generated)).not.toContain('Hidden Cafe')
    expect(
      expectedFor('How many coasters are here?', {
        slug: 'emberwild',
        knowledge: [{ ...input.knowledge[0]!, visibility: 'PRIVATE' }],
      }),
    ).toContain('0 documented')
  })

  it('caps large sets and preserves every ride question in overflow turns', () => {
    const generated = generateVenueQuestions({
      slug: 'emberwild',
      knowledge: Array.from({ length: 50 }, (_, index) => ({
        ...input.knowledge[0]!,
        title: `Thunderbolt ${index}`,
      })),
    })
    expect(generated.cases).toHaveLength(40)
    expect(generated.groupedRideQuestions).toBeGreaterThan(0)
    const turns = generated.cases.flatMap((entry) => entry.turns)
    expect(turns.filter((turn) => turn.startsWith('Who made '))).toHaveLength(50)
    expect(turns.filter((turn) => turn.startsWith('How tall and fast '))).toHaveLength(50)
    for (const entry of generated.cases.filter((entry) => entry.turns.length > 1)) {
      const lines = generated.truth[entry.id]!.split('\n')
      expect(lines).toHaveLength(entry.turns.length)
      entry.turns.forEach((turn, i) => {
        expect(lines[i]).toMatch(new RegExp(`^Turn ${i + 1}:`))
        if (turn.startsWith('Who made ')) expect(lines[i]).toContain('Made by: Ember Engineering')
        else expect(lines[i]).toContain('Size and speed: 120 ft tall')
      })
    }
    expect(generated.cases.filter((entry) => entry.tags.includes('casual'))).toHaveLength(5)
  })

  it('merges place-only coaster facts and normalizes duplicate names', () => {
    const generated = generateVenueQuestions({
      slug: 'emberwild',
      knowledge: [input.knowledge[0]!],
      places: [
        {
          name: ' thunderbolt ',
          type: 'ride',
          shortDescription: 'Thunderbolt is a steel coaster.',
        },
        {
          name: 'Cinderswing',
          type: 'ride',
          longDescription:
            'Cinderswing is a wooden coaster.\nMade by: Ash Works\nSize and speed: Height: 100 ft; 45 mph',
        },
      ],
    })
    expect(
      generated.truth[generated.cases.find((entry) => entry.tags.includes('coaster-count'))!.id],
    ).toContain('2 documented')
    expect(generated.cases.flatMap((entry) => entry.turns)).toContain('Who made Cinderswing?')
    expect(generated.cases.flatMap((entry) => entry.turns)).toContain(
      'How tall and fast is Cinderswing?',
    )
  })

  it('supports hyphenated structure height and proves fallback makers absent', () => {
    const allMakers = [
      'Intamin',
      'Vekoma',
      'Mack',
      'Gerstlauer',
      'Zierer',
      'Maurer',
      'Zamperla',
      'Ember Engineering',
    ]
    const source = {
      slug: 'emberwild',
      knowledge: [
        {
          title: 'Thunderbolt',
          category: 'Rides',
          content: `Thunderbolt is a steel coaster.\nMade by: ${allMakers.join('; ')}\nSize and speed: 100-ft-tall; 40 mph`,
        },
      ],
    }
    const generated = generateVenueQuestions(source)
    expect(generated.cases.find((entry) => entry.tags.includes('maker-absence'))!.turns[0]).toBe(
      'Any Absent Maker 1 rides here?',
    )
    expect(generated.cases.flatMap((entry) => entry.turns)).toContain(
      'How tall and fast is Thunderbolt?',
    )
  })

  it('writes the two JSON files through the CLI', () => {
    const workspace = resolve(import.meta.dirname, '../../../../..')
    const folder = mkdtempSync(join(workspace, 'venue-questions-test-'))
    try {
      const source = join(folder, 'input.json')
      writeFileSync(source, JSON.stringify(input))
      runVenueQuestionCli(['--input', source, '--out', join(folder, 'output')])
      const generated = generateVenueQuestions(input)
      expect(JSON.parse(readFileSync(join(folder, 'output', 'cases.json'), 'utf8'))).toEqual(
        generated.cases,
      )
      expect(JSON.parse(readFileSync(join(folder, 'output', 'truth.json'), 'utf8'))).toEqual(
        generated.truth,
      )
    } finally {
      if (resolve(folder).startsWith(`${workspace}\\`))
        rmSync(folder, { recursive: true, force: true })
    }
    expect(() => runVenueQuestionCli([])).toThrow('Usage:')
  })
})
