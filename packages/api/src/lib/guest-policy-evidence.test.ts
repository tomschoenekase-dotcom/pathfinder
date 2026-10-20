import { describe, expect, it } from 'vitest'

import { guestQuestionNamedRecords, selectGuestQuestionEvidence } from './guest-question-evidence'
import type { GuestDirectoryKnowledge, GuestVenueDirectory } from './guest-venue-directory'

const record = (id: string, title: string, content: string): GuestDirectoryKnowledge => ({
  id,
  title,
  content,
  category: 'GENERAL',
  sourceType: 'FOUNDER_PROVIDED',
  sourceName: 'Fictional policy test',
  sourceUrl: null,
  updatedAt: new Date('2026-10-20T00:00:00Z'),
})

const directory = (knowledge: GuestDirectoryKnowledge[]): GuestVenueDirectory => ({
  knowledge,
  places: [],
  incomplete: false,
})

const select = (query: string, knowledge: GuestDirectoryKnowledge[], maxContextChars = 30_000) =>
  selectGuestQuestionEvidence({
    query,
    directory: directory(knowledge),
    mode: 'DIRECTORY',
    currentDate: '2026-10-20',
    knowledgeInContext: [],
    placesInContext: [],
    maxContextChars,
  })

describe('governing policies in guest evidence', () => {
  it.each(['reserve', 'reserved', 'reserving'])(
    'connects booking wording %s to reservation conditions',
    (word) => {
      const policy = record(
        'booking',
        'Timed reservation policy',
        'Reservations are required on weekends.',
      )
      expect(select(`Is anything ${word}?`, [policy]).knowledge.map((row) => row.id)).toContain(
        'booking',
      )
    },
  )

  it.each(['service dog', 'guide dog', 'assistance animal'])(
    'finds the assistance-animal rule for %s without inferring permission',
    (phrase) => {
      const policy = record(
        'animals',
        'Access and companion policy',
        'Assistance animals may accompany guests on step-free routes. Other animals are not admitted.',
      )
      expect(select(`Can my ${phrase} come with me?`, [policy]).knowledge).toContainEqual(policy)
    },
  )

  it('does not turn a general assistance question into an animal-policy request', () => {
    const policy = record('animals', 'Animal policy', 'Assistance animals may accompany guests.')
    expect(select('Can I get assistance with my payment?', [policy]).knowledge).toEqual([])
  })

  it('retains a relevant governing policy when named-item scores dominate the global floor', () => {
    const neighbours = Array.from({ length: 120 }, (_, index) =>
      record(
        `neighbour-${index}`,
        `Silver Gallery ${index} visitor details`,
        'Silver Gallery displays glass. The route is step-free. Admission charges apply.',
      ),
    )
    const policy = record(
      'access',
      'Access and companion policy',
      'Wheelchairs can use step-free routes. A registered companion receives free admission. ' +
        'This does not override a gallery marked stairs-only.',
    )
    const result = select(
      'Can I visit Silver Gallery 118 and Silver Gallery 119 with a wheelchair and a companion?',
      [...neighbours, policy],
    )
    expect(result.knowledge.map((row) => row.id)).toContain('access')
    expect(result.knowledge.find((row) => row.id === 'access')?.content).toBe(policy.content)
  })

  it('still excludes policies that cannot fit whole and policies unrelated to the question', () => {
    const access = record('access', 'Wheelchair access policy', 'Wheelchair access. '.repeat(100))
    const photos = record('photos', 'Photography policy', 'Flash photography is prohibited.')
    const result = select('Can I visit with a wheelchair?', [access, photos], 100)
    expect(result.knowledge).toEqual([])
    expect(result.trace.budgetExcludedIds).toContain('access')
  })
})

describe('separately named knowledge subjects', () => {
  it('keeps unequal-length names in a comparison instead of only the globally longest phrase', () => {
    const short = record('short', 'Cedar Gallery admission', 'Entry costs $4.')
    const long = record('long', 'Blue River Gallery visitor details', 'Entry costs $8.')
    const found = guestQuestionNamedRecords({
      query: 'Compare Cedar Gallery admission with Blue River Gallery visitor details.',
      directory: directory([short, long]),
      currentDate: '2026-10-20',
    })
    expect(found.knowledge.map((row) => row.id).sort()).toEqual(['long', 'short'])
  })

  it('does not interpret a shorter phrase inside one named subject as a second subject', () => {
    const parent = record('parent', 'Blue River Gallery', 'The main gallery.')
    const child = record('child', 'Blue River Gallery Junior', 'The junior gallery.')
    const found = guestQuestionNamedRecords({
      query: 'Tell me about Blue River Gallery Junior.',
      directory: directory([parent, child]),
      currentDate: '2026-10-20',
    })
    expect(found.knowledge.map((row) => row.id)).toEqual(['child'])
  })
})
