import { describe, expect, it } from 'vitest'

import { THEME_PARK_PLACES } from './evaluation/guest-answer-quality-corpus'
import { guestFacingText, hiddenGuideSentences, isHiddenGuideSentence } from './guest-facing-text'
import { buildGuestGuideCoverage } from './guest-guide-coverage'
import {
  buildGuestVenueDirectoryPrompt,
  buildGuestVenueGuidePrompt,
  createGuestVenueDirectoryCache,
  staleGuestGuideRecordIds,
  type GuestDirectoryKnowledge,
  type GuestVenueDirectory,
} from './guest-venue-directory'
import { guideQualityWarnings, venuePackageGuideQualityWarnings } from './venue-guide-quality'
import { buildVenueSystemPromptParts } from './venue-context'

// What the guide and the model can see is checked here against the records an author supplied:
// no supplied fact may vanish without a warning, go stale behind a newer version, or be swapped
// for another record's fact.

const currentDate = '2026-10-09'
const place = (overrides: Partial<GuestVenueDirectory['places'][number]>) => ({
  ...THEME_PARK_PLACES[0]!,
  areaName: 'Ember Realm',
  itemType: 'activity',
  type: 'ride',
  hours: null,
  shortDescription: null,
  longDescription: null,
  ...overrides,
})
const topic = (
  overrides: Partial<GuestDirectoryKnowledge> & { id: string; title: string },
): GuestDirectoryKnowledge => ({
  category: 'Rides',
  content: '',
  sourceType: 'website_research',
  sourceName: null,
  sourceUrl: null,
  ...overrides,
})
const directoryOf = (
  places: GuestVenueDirectory['places'],
  knowledge: GuestDirectoryKnowledge[],
): GuestVenueDirectory => ({ places, knowledge, incomplete: false })
const venue = {
  id: 'venue-emberwild',
  name: 'Emberwild Park',
  category: 'theme_park',
  description: null,
  guideNotes: null,
  aiGuideNotes: null,
  aiTone: null,
  customPersonality: null,
} as unknown as Parameters<typeof buildVenueSystemPromptParts>[0]['venue']

describe('authoring checks match what the guide drops', () => {
  const boarding =
    'Riders under 42 inches ride only with an adult; exact doors for the Ember boarding gate open at 10 AM.'

  it('warns about a fact-bearing sentence the guide would drop, with its exact path', () => {
    const warnings = guideQualityWarnings([
      {
        kind: 'knowledge',
        path: 'knowledgeEntries.create.0.value',
        title: 'Thunderbolt boarding',
        category: 'Visit',
        content: `Thunderbolt boards from the Ember plaza. ${boarding}`,
      },
    ])
    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'GUIDE_QUALITY_HIDDEN_SENTENCE',
        path: 'knowledgeEntries.create.0.value.content',
      }),
    ])
    expect(warnings[0]!.message).toContain(boarding)
    expect(guestFacingText(`Thunderbolt boards from the Ember plaza. ${boarding}`)).toBe(
      'Thunderbolt boards from the Ember plaza.',
    )
  })

  it('warns for place descriptions as well, in a schemaVersion 3 package', () => {
    const warnings = venuePackageGuideQualityWarnings({
      schemaVersion: 3,
      places: {
        create: [
          {
            value: {
              name: 'Cinderswing',
              type: 'ride',
              itemType: 'activity',
              shortDescription: 'Cinderswing is a swing ride in the Ember realm.',
              longDescription: 'Walking routes to Cinderswing close at 6 PM on event nights.',
            },
          },
        ],
        update: [],
      },
      knowledgeEntries: { create: [], update: [] },
    })
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ['GUIDE_QUALITY_HIDDEN_SENTENCE', 'places.create.0.value.longDescription'],
    ])
  })

  it.each([
    ['See the summary charts for ride heights.', true],
    ['Two source conflicts remain for the coaster.', true],
    ['Visitor photos show the queue entrance.', true],
    ['Visitor photographs show the queue entrance.', true],
    ['The queue is approach anchored at the gate.', true],
    ['Exact doors open at 10 AM.', true],
    ['Sources: https://park.example/a and https://park.example/b.', true],
    ['Checked October 4th against the park site.', true],
    ['Checked October 2025 against the park site.', true],
    ['Thunderbolt is a launched roller coaster in the Ember realm.', false],
    ['Buy tickets online at https://park.example/tickets/.', false],
    ['This pinball arcade is open late.', false],
    ['Visitor photography is allowed everywhere.', false],
    ['Riders must be 48 inches tall.', false],
  ] as const)('warns exactly when the guide drops %j', (sentence, dropped) => {
    expect(guestFacingText(sentence) === '').toBe(dropped)
    expect(isHiddenGuideSentence(sentence)).toBe(dropped)
    expect(hiddenGuideSentences(sentence).length > 0).toBe(dropped)
  })

  it('keeps staff-voice facts and a single usable link without a hidden-sentence warning', () => {
    expect(
      guideQualityWarnings([
        {
          kind: 'knowledge',
          path: 'knowledgeEntries.0',
          title: 'Tickets',
          category: 'Tickets',
          content:
            'Thunderbolt is the tallest coaster at Emberwild Park.\nBuy tickets online at https://park.example/tickets/.',
        },
      ]),
    ).toEqual([])
  })

  it('caps hidden-sentence warnings per package and keeps each message within 600 characters', () => {
    const records = Array.from({ length: 60 }, (_, i) => ({
      kind: 'knowledge' as const,
      path: `knowledgeEntries.${i}`,
      title: `Notes ${'x'.repeat(200)}`,
      category: 'Visit',
      content: `This pin a ${'y'.repeat(300)}. This pin b. This pin c.`,
    }))
    const hidden = guideQualityWarnings(records).filter(
      (w) => w.code === 'GUIDE_QUALITY_HIDDEN_SENTENCE',
    )
    expect(hidden).toHaveLength(100)
    expect(Math.max(...hidden.map((w) => w.message.length))).toBeLessThanOrEqual(600)
  })

  it('caps hidden-sentence warnings per field', () => {
    const warnings = guideQualityWarnings([
      {
        kind: 'knowledge',
        path: 'knowledgeEntries.0',
        title: 'Notes',
        category: 'Visit',
        content: 'This pin a. This pin b. This pin c. This pin d. This pin e.',
      },
    ]).filter((w) => w.code === 'GUIDE_QUALITY_HIDDEN_SENTENCE')
    expect(warnings).toHaveLength(3)
  })
})

describe('source attribution is shortened only when meaning survives', () => {
  it.each([
    ['The current official ride page lists 52 inches to ride.', '52 inches to ride.'],
    [
      'No official ride page lists a height for Thunderbolt.',
      'No official ride page lists a height for Thunderbolt.',
    ],
    [
      'The official park website says nothing about strollers.',
      'The official park website says nothing about strollers.',
    ],
    [
      'Unlike what the official park site says, Thunderbolt closes at 6 PM.',
      'Unlike what the official park site says, Thunderbolt closes at 6 PM.',
    ],
    [
      'Thunderbolt requires 48 inches; the official ride page says 46 inches.',
      'Thunderbolt requires 48 inches; the official ride page says 46 inches.',
    ],
  ])('%j', (input, expected) => {
    expect(guestFacingText(input)).toBe(expected)
  })
})

describe('directory descriptors belong to the right current record', () => {
  const cafe = place({
    id: 'p-cafe',
    name: 'Fictional Café',
    type: 'dining',
    itemType: 'amenity',
    shortDescription: 'Fictional Café is a coffee counter.',
  })
  const oldEvent = topic({
    id: 'k-old',
    title: 'Fictional Café - Summer Season 2025',
    category: 'Events',
    content: 'Summer patio concerts ran nightly in 2025.',
  })
  const hours = topic({
    id: 'k-hours',
    title: 'Fictional Café - Current hours 2026',
    category: 'Hours',
    content: 'Open 8am to 6pm daily in 2026.',
  })

  it('never describes a current place with a past event, in either record order', () => {
    for (const knowledge of [
      [oldEvent, hours],
      [hours, oldEvent],
    ]) {
      const prompt = buildGuestVenueDirectoryPrompt(directoryOf([cafe], knowledge), {
        currentDate,
      })
      expect(prompt).toContain('- Fictional Café (')
      expect(prompt).toContain('): Open 8am to 6pm daily in 2026.')
      expect(prompt).not.toContain('Summer patio concerts')
      expect(prompt).toMatch(/Past dated events[^\n]*\n- Fictional Café - Summer Season 2025/u)
    }
  })

  const north = place({
    id: 'p-north',
    name: 'Rapids (North)',
    shortDescription: 'Rapids North is a river raft ride.',
  })
  const south = place({
    id: 'p-south',
    name: 'Rapids (South)',
    shortDescription: 'Smaller raft ride; 40-inch minimum height.',
  })
  const northTopic = topic({
    id: 'k-north',
    title: 'Rapids (North)',
    content: 'North river raft ride with a 48-inch minimum height.',
  })
  const southTopic = topic({
    id: 'k-south',
    title: 'Rapids (South)',
    content: 'South river raft ride with a 40-inch minimum height.',
  })

  it('keeps each component its own facts when both have topics', () => {
    const prompt = buildGuestVenueDirectoryPrompt(
      directoryOf([north, south], [northTopic, southTopic]),
      { currentDate },
    )
    expect(prompt).toContain('- Rapids (North) (activity, ride, Ember Realm): North river raft')
    expect(prompt).toContain('- Rapids (South) (activity, ride, Ember Realm): South river raft')
    expect(prompt).not.toContain('Topics:')
  })

  it('never lends one component another component’s topic', () => {
    const prompt = buildGuestVenueDirectoryPrompt(directoryOf([north, south], [northTopic]), {
      currentDate,
    })
    expect(prompt).toContain('- Rapids (South) (activity, ride, Ember Realm): Smaller raft ride')
    expect(prompt.match(/48-inch/gu)).toHaveLength(1)
  })

  it('still matches a subtitled topic to its uniquely named place', () => {
    const prompt = buildGuestVenueDirectoryPrompt(
      directoryOf(
        [place({ id: 'p-v', name: 'Vulkara' })],
        [
          topic({
            id: 'k-v',
            title: 'Vulkara: Hydraulic Launch Ride',
            content: 'Hydraulic launch coaster reaching 70 mph.',
          }),
        ],
      ),
      { currentDate },
    )
    expect(prompt).toContain('- Vulkara (activity, ride, Ember Realm): Hydraulic launch coaster')
  })
})

describe('a large directory says what it actually lists', () => {
  const longTitle = (i: number) =>
    `Fictional Topic ${i}: ${'a carefully described visitor service with a long name '.repeat(2)}`

  it('keeps past events and whole colon titles when it falls back to names only', () => {
    const knowledge = Array.from({ length: 250 }, (_, i) =>
      topic({
        id: `k-${i}`,
        title: `Fictional Ride ${i}: Hydraulic Launch Coaster`,
        content:
          'Fictional Ride is a long ride with a long description and many more words about the queue, the theming, the seats and the view.',
      }),
    )
    knowledge.push(
      topic({
        id: 'k-past',
        title: 'Fictional Lantern Festival 2024',
        category: 'Events',
        content: 'Lanterns.',
      }),
    )
    const guide = buildGuestVenueGuidePrompt(directoryOf([], knowledge), {
      currentDate,
      maxFullChars: 1,
    })
    expect(guide.mode).toBe('DIRECTORY')
    expect(guide.prompt).toContain('- [Rides] Fictional Ride 0: Hydraulic Launch Coaster')
    expect(guide.prompt).not.toContain('a long ride with a long description')
    expect(guide.prompt).toMatch(/Past dated events[^\n]*\n- Fictional Lantern Festival 2024/u)
    expect(guide.prompt).toContain('This directory lists every loaded public place and topic record')
    expect(guide.rendererTruncated).toBe(false)
  })

  it('records renderer truncation in coverage while keeping load completeness separate', () => {
    const knowledge = Array.from({ length: 399 }, (_, i) =>
      topic({ id: `k-${i}`, title: longTitle(i), content: 'A service.' }),
    )
    const directory = directoryOf([], knowledge)
    const guide = buildGuestVenueGuidePrompt(directory, { currentDate, maxFullChars: 1 })
    expect(guide.prompt).toContain('may not list every loaded record')
    expect(guide.prompt).not.toContain(longTitle(398).trim())
    expect(guide.rendererTruncated).toBe(true)
    const coverage = buildGuestGuideCoverage({
      guide,
      directory,
      loadStatus: 'READY',
      projectionPath: 'LEGACY',
    })
    expect(coverage).toMatchObject({ incomplete: false, rendererTruncated: true })
    expect(coverage.knowledgeCount).toBe(399)
  })

  it('leaves a small complete directory without the truncation field', () => {
    const directory = directoryOf([], [topic({ id: 'k', title: 'Parking', content: 'Lot A.' })])
    const guide = buildGuestVenueGuidePrompt(directory, { currentDate, maxFullChars: 1 })
    const coverage = buildGuestGuideCoverage({
      guide,
      directory,
      loadStatus: 'READY',
      projectionPath: 'LEGACY',
    })
    expect(coverage).not.toHaveProperty('rendererTruncated')
  })
})

describe('a cached guide never hides a newer retrieved version', () => {
  const t0 = new Date('2026-10-09T12:00:00Z')
  const t1 = new Date('2026-10-09T12:00:30Z')
  const cachedTopic = topic({
    id: 'k-height',
    title: 'Thunderbolt',
    content: 'Thunderbolt is a launched roller coaster.\nHeight: 48 in to ride',
    updatedAt: t0,
  })
  const cachedPlace = place({
    id: 'p-swing',
    name: 'Cinderswing',
    shortDescription: 'Cinderswing is a swing ride.',
    hours: '9am-5pm',
  })

  it('keeps the edited record within the cache window and labels it as replacing the guide', async () => {
    let clock = 0
    const cache = createGuestVenueDirectoryCache({ ttlMs: 60_000, maxEntries: 5, now: () => clock })
    const cached = await cache.get('v', async () => directoryOf([cachedPlace], [cachedTopic]))
    clock = 59_999
    const stillCached = await cache.get('v', async () => {
      throw new Error('should still be cached')
    })
    expect(stillCached).toBe(cached)

    const guide = buildGuestVenueGuidePrompt(stillCached, { currentDate })
    expect(guide.mode).toBe('FULL')
    expect(guide.prompt).toContain('Height: 48 in to ride')
    const fresh = {
      ...cachedTopic,
      content: 'Thunderbolt is a launched roller coaster.\nHeight: 52 in to ride',
      updatedAt: t1,
      distance: 0.1,
    }
    const freshPlace = { ...cachedPlace, hours: '9am-3pm' }
    const stale = staleGuestGuideRecordIds({
      guide,
      directory: stillCached,
      places: [freshPlace],
      knowledgeEntries: [fresh],
    })
    expect([...stale].sort()).toEqual(['knowledge:k-height', 'place:p-swing'])

    const { dynamicPart } = buildVenueSystemPromptParts({
      venue,
      relevantPlaces: [freshPlace],
      knowledgeEntries: [fresh],
      userLat: null,
      userLng: null,
      venueGuideRecordIds: new Set([...guide.recordIds].filter((id) => !stale.has(id))),
      venueGuideUpdatedRecordIds: stale,
    })
    expect(dynamicPart).toContain('Height: 52 in to ride')
    expect(dynamicPart).toContain('Hours: 9am-3pm')
    expect(dynamicPart).toContain('Updated since the VENUE GUIDE was loaded')
    expect(dynamicPart).not.toContain('MOST RELEVANT GUIDE TOPICS')
  })

  it('treats an unedited bounded excerpt, an unversioned record and an unedited place as current', () => {
    const directory = directoryOf([cachedPlace], [cachedTopic])
    const guide = buildGuestVenueGuidePrompt(directory, { currentDate })
    const excerpt = { ...cachedTopic, content: 'Thunderbolt is a launched…\n[source excerpt]' }
    expect(
      staleGuestGuideRecordIds({
        guide,
        directory,
        places: [{ ...cachedPlace }],
        knowledgeEntries: [excerpt, { id: 'k-height' }, { id: 'k-not-in-guide', updatedAt: t1 }],
      }).size,
    ).toBe(0)
  })

  it('never labels an older retrieved copy as replacing a newer guide', () => {
    const directory = directoryOf([], [{ ...cachedTopic, updatedAt: t1 }])
    const guide = buildGuestVenueGuidePrompt(directory, { currentDate })
    const older = { ...cachedTopic, updatedAt: t0 }
    expect(
      staleGuestGuideRecordIds({ guide, directory, places: [], knowledgeEntries: [older] }).size,
    ).toBe(0)
  })

  it('reloads the new version once the cache window ends', async () => {
    let clock = 0
    const cache = createGuestVenueDirectoryCache({ ttlMs: 60_000, maxEntries: 5, now: () => clock })
    await cache.get('v', async () => directoryOf([], [cachedTopic]))
    clock = 60_000
    const reloaded = await cache.get('v', async () =>
      directoryOf([], [{ ...cachedTopic, content: 'Height: 52 in to ride', updatedAt: t1 }]),
    )
    expect(buildGuestVenueGuidePrompt(reloaded, { currentDate }).prompt).toContain(
      'Height: 52 in to ride',
    )
  })
})
