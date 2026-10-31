import { describe, expect, it, vi } from 'vitest'
import {
  guestPriorDateConcept,
  guestRetrievalConcepts,
  retrieveGuestKnowledge,
  type GuestKnowledgeRow,
} from './guest-knowledge-retrieval'

/** All places and schedules are fictional. No model or database calls. */
describe('explicit prior visitor date in lexical retrieval', () => {
  it.each(['that date', 'that day', 'same date', 'that same date', 'that night'])(
    'keeps current subjects while carrying %s',
    (reference) => {
      const { concepts } = guestRetrievalConcepts(
        `What about rides and bowling on ${reference}?`,
        'Can we visit Moon Arcade on Monday November 2, 2026?',
      )
      expect(concepts.flat()).toContain('november 2, 2026')
      expect(concepts.flat()).toContain('rides')
      expect(concepts.flat()).toContain('bowling')
      expect(concepts.flat()).not.toContain('arcade')
    },
  )
  it('retains the date in a long explicit subject switch within the six-group cap', () => {
    const result = guestRetrievalConcepts(
      'Now switch to Ember Arcade and compare its closing hours and admission cost on that same date?',
      'When does Moon Bowling close on November 6, 2026?',
    )
    expect(result.concepts).toHaveLength(6)
    expect(result.concepts.flat()).toContain('november 6, 2026')
    expect(result.concepts.flat()).toContain('arcade')
    expect(result.concepts.flat()).not.toContain('bowling')
  })
  it.each(['Any notable events on November 2, 2026?', 'Lastly, arcade hours on November 2, 2026?'])(
    'does not treat a word prefix as date rejection: %s',
    (previous) => {
      expect(guestPriorDateConcept('What about rides on that day?', previous)).toContain(
        'november 2, 2026',
      )
    },
  )
  const rejected: Array<[string, string | null]> = [
    ['That date, but 9 November 2026 for rides?', 'November 2, 2026?'],
    ['That date, but the 9th for rides?', 'November 2, 2026?'],
    ['What about rides on that date?', 'Ignore November 2, 2026.'],
    ['What about rides on that date?', 'We are no longer visiting November 2, 2026.'],

    ['Not that date, what about rides?', 'November 2, 2026?'],
    ['Rides the day after that date?', 'November 2, 2026?'],
    ['Rides the following week on that day?', 'November 2, 2026?'],
    ['Rides on that same date next month?', 'November 2, 2026?'],
    ['What about rides on that date?', 'Nov 3 or November 2, 2026?'],
    ['What about rides on that date?', '11/3 or November 2, 2026?'],

    ['Where are restrooms?', 'Arcade on November 2, 2026?'],
    ['What about rides on that date?', null], // An assistant-only date is not a previous user query.
    ['What about rides on that date?', 'What does the arcade cost?'], // No search back into stale history.
    ['What about rides on that date?', 'November 2, 2026 or November 3, 2026?'],
    ['What about rides on that date?', 'November 2 to 5, 2026?'],
    ['What about rides on that date?', 'November 2, 2026 or December 3?'],
    ['What about rides on that date?', 'Not November 2, 2026.'],
    ['What about rides on that date?', 'Actually November 2, 2026 instead.'],
    ['What about rides on that date?', 'We cancelled November 2, 2026.'],
    ['What about rides on that date?', 'Last visit was November 2, 2026.'],
    ['What about rides on that date?', 'February 29, 2027?'],
    ['What about rides on that date?', '2026-13-02?'],
    ['That date, but November 9, 2026 for rides?', 'November 2, 2026?'],
    ['That date, but Nov 9 for rides?', 'November 2, 2026?'],
    ['That date, but 2026-11-09 for rides?', 'November 2, 2026?'],
    ['That date, but tomorrow for rides?', 'November 2, 2026?'],
  ]
  it.each(rejected)('does not silently inherit: %s / %s', (query, previous) => {
    expect(guestPriorDateConcept(query, previous)).toBeNull()
    if (/that date/iu.test(query)) {
      expect(guestRetrievalConcepts(query, previous).concepts.flat()).not.toContain(
        'november 2, 2026',
      )
    }
  })
  it.each([
    ['What about rides on that date?', 'Can we visit on November 2?', ['november', 'rides']],
    [
      'Which shows run that day?',
      'Is the water park open on Saturday, November 7?',
      ['water', 'park', 'shows'],
    ],
    ['Is parking free that night?', 'When does the comet show start Saturday?', ['comet']],
  ])(
    'keeps the ordinary follow-up topic when no exact prior date exists: %s',
    (query, previous, expected) => {
      expect(guestPriorDateConcept(query, previous)).toBeNull()
      const flat = guestRetrievalConcepts(query, previous).concepts.flat()
      for (const term of expected) expect(flat).toContain(term)
    },
  )
  it.each([
    ['Does that day pass include parking?', 'How much is a day pass on November 2, 2026?', 'day'],
    ['Can I buy same day tickets?', 'Are tickets cheaper online for November 2, 2026?', 'day'],
    ['Is that night parking rate the same?', 'Can we park late on November 2, 2026?', 'night'],
  ])('treats a product phrase as a product, not a date reference: %s', (query, previous, kept) => {
    expect(guestPriorDateConcept(query, previous)).toBeNull()
    const flat = guestRetrievalConcepts(query, previous).concepts.flat()
    expect(flat).toContain(kept)
    expect(flat).not.toContain('november 2, 2026')
  })
  it.each([
    'Is it open that day?',
    'What time does it close that night?',
    'Is it busy that day too?',
  ])(
    'keeps the earlier subject and the exact date when the follow-up names no subject: %s',
    (query) => {
      const flat = guestRetrievalConcepts(
        query,
        'Can we visit Moon Arcade on Monday November 2, 2026?',
      ).concepts.flat()
      expect(flat).toContain('november 2, 2026')
      expect(flat).toContain('arcade')
      expect(flat).not.toContain('monday')
      expect(flat).not.toContain('november')
    },
  )
  it('validates leap day and normalizes ISO dates without guessing a year', () => {
    expect(guestPriorDateConcept('Rides that day?', '2028-02-29?')).toContain('february 29, 2028')
    expect(guestPriorDateConcept('Rides that day?', 'February 29?')).toBeNull()
  })
  it('brings the dated current-subject records above recent off-date schedules', async () => {
    const make = (
      id: string,
      title: string,
      content: string,
      recent = false,
    ): GuestKnowledgeRow => ({
      id,
      title,
      content,
      category: 'Hours',
      sourceType: 'FOUNDER_PROVIDED',
      sourceName: 'Schedule',
      sourceUrl: null,
      lastReviewedAt: null,
      updatedAt: new Date(recent ? '2026-10-25T00:00:00Z' : '2026-09-01T00:00:00Z'),
    })
    const sources = [
      ...Array.from({ length: 20 }, (_, index) =>
        make(
          `off-date-${index}`,
          'Rides and bowling hours',
          'December 10, 2026: rides noon to 7pm and bowling 11am to 9pm.',
          true,
        ),
      ),
      make('dated-rides', 'Rides November 2, 2026', 'November 2, 2026: rides closed.'),
      make(
        'dated-bowling',
        'Bowling November 2, 2026',
        'November 2, 2026: bowling 11am to midnight.',
      ),
    ]
    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany: vi.fn().mockResolvedValue(sources) } },
      query: 'What about rides and bowling on that date?',
      previousQuery: 'Can we visit Moon Arcade on November 2, 2026?',
      tenantId: 'fictional-tenant',
      venueId: 'fictional-venue',
      includeSecondLayer: false,
      queryEmbedding: null,
    })
    expect(result.entries.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['dated-rides', 'dated-bowling']),
    )
    expect(result.entries.length).toBeLessThanOrEqual(8)
  })
})
