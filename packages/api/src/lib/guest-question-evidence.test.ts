import { describe, expect, it, vi } from 'vitest'

import { guestQueryConcepts } from './guest-knowledge-retrieval'
import {
  QUESTION_EVIDENCE_MAX_FOCUS_TOPICS,
  guestQuestionNamedRecords,
  guestQuestionTerms,
  mergeGuestQuestionEvidencePlaces,
  revalidateGuestQuestionEvidence,
  selectGuestQuestionEvidence,
} from './guest-question-evidence'
import {
  buildGuestVenueGuidePrompt,
  guestKnowledgeNamedPlaces,
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

const select = (
  query: string,
  overrides: Partial<Parameters<typeof selectGuestQuestionEvidence>[0]> = {},
) =>
  selectGuestQuestionEvidence({
    query,
    directory: directory(),
    mode: 'DIRECTORY',
    currentDate: '2026-11-21',
    knowledgeInContext: [],
    placesInContext: [],
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
    const result = select(
      '¿Podemos hacer fotos durante la charla de las nutrias? ¿Está incluida en la entrada?',
    )
    expect(result.knowledge.map((entry) => entry.id)).toContain('otter-talk')
  })

  it('keeps whole records and never exceeds the context budget', () => {
    const result = select(
      'Which reef tanks can adults and children watch, and how many minutes each?',
      {
        maxContextChars: 6_000,
      },
    )
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
    const result = select('Touch pool help for children, and how long does it take?', {
      mode: 'FULL',
    })
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

  it('never treats the venue name as a question part', () => {
    const terms = guestQuestionTerms(
      'Can we buy sandwiches around Coral Cove?',
      null,
      'Coral Cove Aquarium',
    )
    expect(terms.map((term) => term.key)).not.toContain('word:coral')
    expect(terms.map((term) => term.key)).not.toContain('word:cove')
  })

  it('points a FULL guide only at topics close to the strongest match', () => {
    const result = select('How much is the glass bottom boat at sunset?', { mode: 'FULL' })
    expect(result.knowledge.map((entry) => entry.id)).toEqual(['boat-fares'])
  })

  it('adds nothing when the guide is absent', () => {
    expect(select('How much is the boat?', { mode: 'NONE' }).knowledge).toEqual([])
  })

  it('borrows the previous question only for a short referential follow-up', () => {
    const terms = guestQuestionTerms('and how much is it?', 'Tell me about the glass bottom boat')
    expect(terms.some((term) => term.key === 'word:botto')).toBe(true)
    expect(
      guestQuestionTerms('How much is the otter talk?', 'glass bottom boat').some(
        (term) => term.key === 'word:botto',
      ),
    ).toBe(false)
  })
})

describe('question evidence precision (independent review findings)', () => {
  const keys = (query: string) => guestQuestionTerms(query).map((term) => term.key)

  it('matches intent groups by whole word, never by a shared prefix', () => {
    // visitors/visit, experience/experimentar, closest/close, alternative/alter, charging/charge
    for (const query of [
      'How many visitors come here?',
      'What is the best experience?',
      'Which café is closest?',
      'Is there an alternative route?',
      'Where can I charge my phone? I need charging',
    ])
      expect(keys(query).filter((key) => key.startsWith('intent:')).length).toBeLessThanOrEqual(1)
    expect(
      keys('How old is the castle and what year was it built?').some((key) =>
        key.startsWith('intent:'),
      ),
    ).toBe(false)
  })

  it('selects nothing for chit-chat or questions made only of common words', () => {
    expect(select('ok thanks!').knowledge).toEqual([])
    expect(select('Reef tank alcove rail?').knowledge.length).toBe(0)
  })

  it('ignores bare numbers as question parts', () => {
    expect(keys('Our kids are 5 and 11')).not.toContain('word:5')
    expect(keys('Our kids are 5 and 11')).not.toContain('word:11')
  })

  it('keeps English content words that are function words elsewhere', () => {
    expect(guestQueryConcepts('Can we see the fur seals and the hay barn?').flat()).toEqual(
      expect.arrayContaining(['fur', 'hay']),
    )
  })

  it('splits unspaced CJK questions so they can match records', () => {
    expect(guestQuestionTerms('水族館の写真撮影は大丈夫ですか').length).toBeGreaterThan(3)
  })

  it('treats step-free as one access word, not as free entry', () => {
    expect(keys('Is the gallery step-free?')).not.toContain(keys('Is it free?')[0])
  })

  it('never hydrates places when the caller keeps its own place ranking', () => {
    expect(select('Where can my kids touch starfish?', { allowPlaces: false }).places).toEqual([])
  })

  it('counts hydrated place descriptions toward the body budget', () => {
    const long = place(
      'p-long',
      'Starfish Grotto',
      `Touch starfish here. ${'Kids touch starfish. '.repeat(400)}`,
    )
    const result = select('Where can my kids touch starfish?', {
      directory: directory({ places: [long] }),
      maxContextChars: 2_000,
    })
    expect(result.places).toEqual([])
    expect(result.trace.budgetExcludedIds).toContain('p-long')
  })
})

describe('second review findings', () => {
  it('keeps a real topic that several records mention', () => {
    const lockers = Array.from({ length: 5 }, (_, index) =>
      knowledge(
        `locker-${index}`,
        `Gate ${index} services`,
        'Lockers are by the gate. Coins only.',
      ),
    )
    const others = Array.from({ length: 25 }, (_, index) =>
      knowledge(`other-${index}`, `Exhibit ${index}`, 'A quiet room with old maps and benches.'),
    )
    const result = select('Where are the lockers?', {
      directory: directory({ knowledge: [...lockers, ...others], places: [] }),
    })
    expect(result.knowledge.length).toBeGreaterThan(0)
    expect(result.knowledge.every((entry) => entry.id.startsWith('locker-'))).toBe(true)
  })

  it('keeps long words with a shared short prefix apart', () => {
    const keys = guestQuestionTerms('What are the height restrictions?').map((term) => term.key)
    const restroom = guestQuestionTerms('Where are the restrooms?').map((term) => term.key)
    expect(keys.some((key) => restroom.includes(key))).toBe(false)
  })

  it('merges evidence places without displacing retrieved ones or exceeding the limit', () => {
    const p = (id: string) => ({ id })
    const merged = mergeGuestQuestionEvidencePlaces({
      places: ['entry', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'].map(p),
      added: ['a1', 'a2', 'r2'].map(p),
      pinnedId: 'entry',
      limit: 8,
      retrievedSlots: 5,
    }).map((place) => place.id)
    expect(merged.slice(0, 8)).toEqual(['entry', 'r1', 'r2', 'r3', 'r4', 'r5', 'a1', 'a2'])
    expect(new Set(merged).size).toBe(merged.length)
    expect(merged).toContain('r7')
  })
})

describe('question evidence revalidation', () => {
  it('drops withdrawn records and sends edited records in their current form', async () => {
    const edited = { ...governing[1]!, content: 'The glass-bottom boat costs 6 for adults.' }
    const findMany = vi.fn().mockResolvedValue([
      {
        ...edited,
        updatedAt: new Date('2026-11-21T10:00:00Z'),
        lastReviewedAt: null,
        contentModuleId: null,
      },
    ])
    const result = await revalidateGuestQuestionEvidence({
      reader: { venueKnowledgeEntry: { findMany } },
      tenantId: 't',
      venueId: 'v',
      includeSecondLayer: false,
      asOf: new Date('2026-11-21T12:00:00Z'),
      currentDate: '2026-11-21',
      knowledge: [governing[0]!, governing[1]!],
    })
    expect(result.map((entry) => entry.id)).toEqual(['boat-fares'])
    expect(result[0]!.content).toContain('6')
    const where = findMany.mock.calls[0]![0].where
    expect(where).toMatchObject({
      tenantId: 't',
      venueId: 'v',
      id: { in: ['otter-talk', 'boat-fares'] },
    })
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
    const concepts = guestQueryConcepts(
      'Pour un adulte, combien coûte le supplément dans la voiture ?',
    ).flat()
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

  it('links a one-word place name only through a separator', () => {
    const guide = directory({
      places: [place('p-kids', 'Kids', 'Play area.'), place('p-aviary', 'Aviary', 'Birds.')],
      knowledge: [
        knowledge('kids-free', 'Kids eat free on Tuesdays', 'Children eat free.', 'dining'),
        knowledge('aviary-times', 'Aviary: feeding times', 'Feeding at 11:00.'),
      ],
    })
    const links = guestTopicPlaceLinks(guide)
    expect(links.get('p-kids')).toBeUndefined()
    expect(links.get('p-aviary')).toEqual(['aviary-times'])
  })

  it('does not link a topic whose title merely starts with a longer word', () => {
    const guide = directory({
      knowledge: [knowledge('touchpoint', 'Touch Poolside cafe', 'Coffee and cakes.', 'dining')],
    })
    expect(guestTopicPlaceLinks(guide).size).toBe(0)
  })
})

describe('records named by the visitor or by a context record', () => {
  // Numbered names share every word with their neighbours, so search alone cannot tell them apart.
  const hides = Array.from({ length: 60 }, (_, index) =>
    place(`hide-${index}`, `Alder Hide ${String(900 + index).padStart(5, '0')}`, 'A bird hide.'),
  )
  const hideDetails = Array.from({ length: 60 }, (_, index) =>
    knowledge(
      `hide-k-${index}`,
      `Birch Hide ${String(900 + index).padStart(5, '0')} visitor details`,
      'Guests must be at least 6 years old.',
    ),
  )
  const named = (query: string, extra: Partial<GuestVenueDirectory> = {}) =>
    guestQuestionNamedRecords({
      query,
      currentDate: '2026-11-21',
      directory: directory({
        knowledge: [...governing, ...hideDetails],
        places: [
          ...hides,
          place('p-wheel', 'Harvest Wheel', 'Main wheel.'),
          place('p-wheel-junior', 'Harvest Wheel Junior', 'Small wheel.'),
        ],
        ...extra,
      }),
    })

  it('finds a numbered place the visitor names, among neighbours sharing every other word', () => {
    const result = named('Can my 9 year old visit Alder Hide 00958 on her own?')
    expect(result.places.map((row) => row.id)).toEqual(['hide-58'])
  })

  it('lets a longer name claim its words before a shorter name inside it', () => {
    expect(named('Is Harvest Wheel Junior step-free?').places.map((row) => row.id)).toEqual([
      'p-wheel-junior',
    ])
    expect(
      named('Compare Harvest Wheel and Harvest Wheel Junior for a 7 year old')
        .places.map((row) => row.id)
        .sort(),
    ).toEqual(['p-wheel', 'p-wheel-junior'])
  })

  it('finds a knowledge-only item by a long exact title phrase, including a numbered pair', () => {
    expect(named('How long is Birch Hide 00931?').knowledge.map((row) => row.id)).toEqual([
      'hide-k-31',
    ])
    // Two shared words that are not a number name nothing.
    expect(named('Which hide visitor rules apply?').knowledge).toEqual([])
  })

  it('names nothing for an ordinary topic question and skips same-name places', () => {
    expect(named('What time does the otter talk start?').places).toEqual([])
    const twins = [place('a', 'Twin Kiosk', 'East.'), place('b', 'Twin Kiosk', 'West.')]
    expect(named('Where is Twin Kiosk?', { places: twins }).places).toEqual([])
  })

  it('follows the members a context record enumerates, not a lone subject or a long overview', () => {
    const members = ['Copper Wheel', 'Copper Wheel Junior', 'Reed Walk', 'Story Barn'].map(
      (name, index) => place(`m-${index}`, name, 'A stop.'),
    )
    const others = Array.from({ length: 12 }, (_, index) =>
      place(`o-${index}`, `Lantern Stall ${index + 10}`, 'A stall.'),
    )
    const places = [...members, ...others]
    const route = knowledge(
      'route',
      'Discovery route',
      'The discovery route consists of Copper Wheel, Copper Wheel Junior, Reed Walk, and Story Barn.',
    )
    const lone = knowledge('lone', 'Reed Walk closure', 'Reed Walk closes on Mondays.')
    const overview = knowledge(
      'overview',
      'Every stall',
      others.map((row) => row.name).join(', ') + '.',
    )
    const followed = (rows: GuestDirectoryKnowledge[]) =>
      guestKnowledgeNamedPlaces({ knowledge: rows, directory: directory({ places }) }).map(
        (row) => row.id,
      )
    expect(followed([route])).toEqual(['m-0', 'm-1', 'm-2', 'm-3'])
    expect(followed([lone])).toEqual([])
    expect(followed([overview])).toEqual([])
  })
})
