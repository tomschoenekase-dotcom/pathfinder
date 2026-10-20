import { describe, expect, it } from 'vitest'

import { guestQueryConcepts } from './guest-knowledge-retrieval'
import {
  QUESTION_EVIDENCE_MAX_FOCUS_TOPICS,
  guestQuestionTerms,
  selectGuestQuestionEvidence,
} from './guest-question-evidence'
import {
  buildGuestVenueGuidePrompt,
  guestTopicPlaceLinks,
  type GuestDirectoryKnowledge,
  type GuestDirectoryPlace,
  type GuestVenueDirectory,
} from './guest-venue-directory'

const knowledge = (
  id: string,
  title: string,
  content: string,
  category = 'visit',
): GuestDirectoryKnowledge => ({
  id,
  title,
  category,
  content,
  sourceType: 'FOUNDER_PROVIDED',
  sourceName: 'Fictional test guide',
  sourceUrl: null,
  updatedAt: new Date('2026-11-01T00:00:00Z'),
})

const place = (id: string, name: string, shortDescription: string): GuestDirectoryPlace => ({
  id,
  name,
  type: 'exhibit',
  itemType: 'exhibit',
  shortDescription,
  longDescription: null,
  lat: null,
  lng: null,
  tags: [],
  areaName: 'Main hall',
  hours: null,
  photoUrl: null,
  sourceType: 'FOUNDER_PROVIDED',
  sourceName: 'Fictional test guide',
  sourceUrl: null,
})

// Same-domain distractors share everyday venue words ("minutes", "adults", "included").
const distractors = Array.from({ length: 40 }, (_, index) =>
  knowledge(
    `tank-${index}`,
    `Reef tank ${index + 1}`,
    `Reef tank ${index + 1} shows coral and small fish in a dim alcove. Allow about ${5 + (index % 4)} minutes. ` +
      'Adults and children watch from a low rail. '.repeat(60),
  ),
)

const governing = [
  knowledge(
    'otter-talk',
    'Otter feeding talk',
    'Keepers describe how otters crack shellfish while they feed. The talk lasts 15 minutes. ' +
      'It is included in admission. Seats are first come, first served, and photography without flash is allowed during the talk.',
  ),
  knowledge(
    'boat-fares',
    'Glass-bottom boat fares',
    'The glass-bottom boat circles the outer lagoon. Adults pay $14 and children aged 4 to 12 pay $7. ' +
      'Children under 4 ride free but need a boarding pass. A sunset sailing adds $10 per booking, not per passenger.',
    'tickets',
  ),
  knowledge(
    'touch-pool',
    'Touch Pool',
    'The Touch Pool lets visitors feel starfish and urchins with two fingers. It takes about 10 minutes. ' +
      'Children under 6 must be helped by an adult at the rail.',
  ),
]

const directory = (extra: Partial<GuestVenueDirectory> = {}): GuestVenueDirectory => ({
  knowledge: [...distractors, ...governing],
  places: [place('p-touch', 'Touch Pool', 'Hands-on pool with starfish; allow 10 minutes.')],
  incomplete: false,
  ...extra,
})

const select = (query: string, overrides: Partial<Parameters<typeof selectGuestQuestionEvidence>[0]> = {}) =>
  selectGuestQuestionEvidence({
    query,
    directory: directory(),
    mode: 'DIRECTORY',
    currentDate: '2026-11-21',
    knowledgeInContext: [],
    placeIdsInContext: new Set(),
    ...overrides,
  })

describe('question evidence', () => {
  it('hydrates the record for a later part of a multi-part question', () => {
    const result = select(
      'My two kids are 5 and 11 and my partner and I want the glass bottom boat at sunset. How much is that, and is the sunset extra charged per person?',
    )
    expect(result.knowledge.map((entry) => entry.id)).toContain('boat-fares')
    expect(result.knowledge.map((entry) => entry.id)).not.toContain('tank-0')
  })

  it('does not depend on the order of equivalent question parts', () => {
    const a = select('Is the otter talk included in admission, and can we take photos there?')
    const b = select('Can we take photos at the otter talk, and is it included in admission?')
    expect(a.knowledge.map((entry) => entry.id).sort()).toEqual(
      b.knowledge.map((entry) => entry.id).sort(),
    )
    expect(a.knowledge.map((entry) => entry.id)).toContain('otter-talk')
  })

  it('matches a question written in another language through shared intents and cognates', () => {
    const result = select('¿Podemos hacer fotos durante la charla de las nutrias? ¿Está incluida en la entrada?')
    expect(result.knowledge.map((entry) => entry.id)).toContain('otter-talk')
  })

  it('keeps whole records and never exceeds the context budget', () => {
    const result = select('Which reef tanks can adults and children watch, and how many minutes each?', {
      maxContextChars: 6_000,
    })
    const chars = result.knowledge.reduce((sum, entry) => sum + entry.content.length, 0)
    expect(chars).toBeLessThanOrEqual(6_000)
    for (const entry of result.knowledge)
      expect(entry.content).toBe(directory().knowledge.find((row) => row.id === entry.id)!.content)
    expect(result.trace.budgetExcludedIds.length).toBeGreaterThan(0)
  })

  it('does not repeat records already in context and counts their coverage', () => {
    const result = select('How much is the glass bottom boat?', {
      knowledgeInContext: [governing[1]!],
    })
    expect(result.knowledge.map((entry) => entry.id)).not.toContain('boat-fares')
    expect(result.trace.uncoveredTerms).toEqual([])
  })

  it('reports question parts no whole record in context answers', () => {
    const result = select('Is there a dog park near the penguins?')
    expect(result.trace.uncoveredTerms.length).toBeGreaterThan(0)
  })

  it('in FULL mode adds only a bounded set of topic names and never places', () => {
    const result = select('Touch pool help for children, and how long does it take?', { mode: 'FULL' })
    expect(result.knowledge.length).toBeLessThanOrEqual(QUESTION_EVIDENCE_MAX_FOCUS_TOPICS)
    expect(result.knowledge.map((entry) => entry.id)).toContain('touch-pool')
    expect(result.places).toEqual([])
  })

  it('hydrates matching places in DIRECTORY mode but never same-name places', () => {
    const twin = place('p-touch-2', 'Touch Pool', 'Second hands-on pool; allow 10 minutes.')
    const single = select('Where can my kids touch starfish?')
    expect(single.places.map((entry) => entry.id)).toContain('p-touch')
    const duplicated = select('Where can my kids touch starfish?', {
      directory: directory({ places: [directory().places[0]!, twin] }),
    })
    expect(duplicated.places).toEqual([])
  })

  it('never hydrates an ended dated event', () => {
    const ended = knowledge(
      'lantern-2025',
      'Lantern Night 2025',
      'Lantern Night took place on November 8, 2025 from 18:00 to 21:00 with otter shellfish lanterns.',
      'event',
    )
    const result = select('When is Lantern Night with the otter lanterns?', {
      directory: directory({ knowledge: [...distractors, ...governing, ended] }),
    })
    expect(result.knowledge.map((entry) => entry.id)).not.toContain('lantern-2025')
  })

  it('adds nothing when the guide is absent', () => {
    expect(select('How much is the boat?', { mode: 'NONE' }).knowledge).toEqual([])
  })

  it('borrows the previous question only for a short referential follow-up', () => {
    const terms = guestQuestionTerms('and how much is it?', 'Tell me about the glass bottom boat')
    expect(terms.some((term) => term.key === 'word:botto')).toBe(true)
    expect(guestQuestionTerms('How much is the otter talk?', 'glass bottom boat').some(
      (term) => term.key === 'word:botto',
    )).toBe(false)
  })
})

describe('lexical query concepts', () => {
  it('keeps a late informative part instead of the first words of a long question', () => {
    const concepts = guestQueryConcepts(
      'My dad uses a wheelchair and my five year old likes doing things, what could we do together in twenty minutes and is the stamp trail included in entry?',
    ).flat()
    expect(concepts).toContain('included')
    expect(concepts).toContain('wheelchair')
  })

  it('ignores function words in other languages', () => {
    const concepts = guestQueryConcepts('Pour un adulte, combien coûte le supplément dans la voiture ?').flat()
    expect(concepts).not.toContain('pour')
    expect(concepts).not.toContain('dans')
    expect(concepts).toContain('supplement')
  })
})

describe('subject grouping in the full guide', () => {
  it('places a topic about a place directly after that place', () => {
    const guide = directory({
      knowledge: [
        knowledge('hours', 'Opening hours', 'Open daily 9:00 to 17:00.', 'hours'),
        governing[2]!,
        knowledge('touch-rules', 'Touch Pool hand washing', 'Wash hands before and after.'),
      ],
    })
    const links = guestTopicPlaceLinks(guide)
    expect(links.get('p-touch')).toEqual(['touch-pool', 'touch-rules'])
    const prompt = buildGuestVenueGuidePrompt(guide, { currentDate: '2026-11-21' }).prompt
    const placeAt = prompt.indexOf('<place name="Touch Pool"')
    const topicAt = prompt.indexOf('<topic title="Touch Pool"')
    const rulesAt = prompt.indexOf('<topic title="Touch Pool hand washing"')
    const hoursAt = prompt.indexOf('<topic title="Opening hours"')
    expect(placeAt).toBeGreaterThan(-1)
    expect(topicAt).toBeGreaterThan(placeAt)
    expect(rulesAt).toBeGreaterThan(topicAt)
    expect(hoursAt).toBeGreaterThan(rulesAt)
  })

  it('does not link a topic whose title merely starts with a longer word', () => {
    const guide = directory({
      knowledge: [knowledge('touchpoint', 'Touch Poolside cafe', 'Coffee and cakes.', 'dining')],
    })
    expect(guestTopicPlaceLinks(guide).size).toBe(0)
  })
})
