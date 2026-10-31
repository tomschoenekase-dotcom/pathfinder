import { describe, expect, it } from 'vitest'
import {
  guestOffsetDateConcept,
  guestPriorDateConcept,
  guestRetrievalConcepts,
  guestStatedDates,
  retrieveGuestKnowledge,
  type GuestKnowledgeRow,
} from './guest-knowledge-retrieval'

/** All places, dates and schedules are fictional. No model or database calls. */
const CLOCK = new Date('2026-10-12T15:00:00Z') // Monday, October 12, 2026

describe('stated visitor dates (shared helper)', () => {
  it.each([
    ['Is Moon Bowl open Saturday, October 17, 2026?', ['october 17, 2026']],
    ['Hours on 2026-10-17?', ['october 17, 2026']],
    ['Hours on Oct. 17?', ['october 17, 2026']],
    ['Rides on Saturday, October 17?', ['october 17, 2026']],
    ['Is it open January 3?', ['january 3, 2027']], // next occurrence, year rollover
    ['Open Friday, January 1?', ['january 1, 2027']], // weekday picks the year
    ['Shows on October 17 and October 18?', ['october 17, 2026', 'october 18, 2026']],
  ])('resolves %s', (text, expected) => {
    expect(guestStatedDates(text, CLOCK)?.terms).toEqual(expect.arrayContaining(expected))
  })

  it.each([
    ['Is it open October 17?', null], // no clock: never guess the year
    ['Rides on Saturday, October 18, 2026?', CLOCK], // weekday conflicts with the date
    ['Rides on February 30?', CLOCK], // invalid date
    ['Rides on June 5?', CLOCK], // eight months ahead or recently past: unclear year
    ['Rides on October 17 or October 18?', CLOCK], // alternatives
    ['Rides from October 17 to October 20?', CLOCK], // open range form
    ['Rides after October 17?', CLOCK], // a boundary, not a visit day
    ['Rides on October 17 and 10/18?', CLOCK], // unparsed date form
    ['Rides tomorrow or October 17?', CLOCK],
    ['Rides on the 17th of October?', CLOCK],
    ['Rides October 1, 2, 3 and 4?', CLOCK],
  ])('fails closed for %s', (text, clock) => {
    expect(guestStatedDates(text, clock)).toBeNull()
  })

  it('validates leap days by year', () => {
    expect(guestStatedDates('Open February 29, 2028?')?.terms).toContain('february 29, 2028')
    expect(guestStatedDates('Open February 29, 2027?')).toBeNull()
    expect(guestStatedDates('Open February 29?', CLOCK)).toBeNull()
  })

  it('expands a bounded "between" interval to every day, never just the two ends', () => {
    const range = guestStatedDates('Is the arcade open between October 17 and October 20?', CLOCK)
    expect(range?.kind).toBe('range')
    expect(range?.dates).toHaveLength(4)
    expect(range?.terms).toEqual(
      expect.arrayContaining(['october 17, 2026', 'october 18, 2026', 'october 19, 2026', 'october 20, 2026']),
    )
  })

  it('reads "deciding between X and Y" as two candidate days, not an interval', () => {
    const choice = guestStatedDates(
      "We're deciding between Sunday, October 25 and Saturday, October 31, 2026. Which day is better?",
      CLOCK,
    )
    expect(choice?.kind).toBe('list')
    expect(choice?.terms).toEqual(expect.arrayContaining(['october 25, 2026', 'october 31, 2026']))
    expect(choice?.terms).not.toContain('october 28, 2026')
  })

  it('rolls a "between" interval across the year end', () => {
    const range = guestStatedDates('Open between December 30, 2026 and January 2?', CLOCK)
    expect(range?.terms).toEqual(
      expect.arrayContaining(['december 30, 2026', 'december 31, 2026', 'january 1, 2027', 'january 2, 2027']),
    )
  })

  it('applies one trailing year to both ends', () => {
    expect(guestStatedDates('Between November 7 and November 9, 2026?')?.dates).toHaveLength(3)
  })

  it.each([
    'Between October 20 and October 17?', // reversed within one year
    'Between October 1 and October 30?', // too long to enumerate
    'Between October 17 and October 17?',
    'Between Friday, October 17 and October 18?', // weekday conflict
  ])('fails closed for an unclear interval: %s', (text) => {
    expect(guestStatedDates(text, CLOCK)).toBeNull()
  })
})

describe('first-turn dates in retrieval concepts', () => {
  it('keeps the subject words and adds the exact date (first question)', () => {
    const result = guestRetrievalConcepts(
      "We'll be in Moon Harbor on Saturday, October 17, 2026. What hours are the boardwalk rides running?",
      null,
      CLOCK,
    )
    const flat = result.concepts.flat()
    expect(flat).toContain('october 17, 2026')
    expect(flat).toContain('rides')
    expect(flat).not.toContain('saturday')
    expect(flat).not.toContain('17')
    expect(result.dateConcept).toContain('october 17, 2026')
  })

  it('a later turn with its own date replaces the earlier date and keeps the earlier subject', () => {
    const flat = guestRetrievalConcepts(
      'What about October 18?',
      'When does Moon Bowl close on October 17, 2026?',
      CLOCK,
    ).concepts.flat()
    expect(flat).toContain('october 18, 2026')
    expect(flat).not.toContain('october 17, 2026')
    expect(flat).toContain('bowl')
  })

  it('carries a bounded "between" interval for "those days"', () => {
    const terms = guestPriorDateConcept(
      'What about the rides on those days?',
      'Between November 7 and November 9, 2026, is the arcade open?',
    )
    expect(terms).toEqual(
      expect.arrayContaining(['november 7, 2026', 'november 8, 2026', 'november 9, 2026']),
    )
    expect(
      guestPriorDateConcept('What about rides on that day?', 'Between November 7 and November 9, 2026?'),
    ).toBeNull()
  })
})

describe('one-step offsets from exactly one earlier visitor date', () => {
  const previous = 'Is Moon Bowl open Saturday, October 17, 2026?'
  it.each([
    ['What about the next day?', 'october 18, 2026'],
    ['And the day after?', 'october 18, 2026'],
    ['Is the arcade open the following day?', 'october 18, 2026'],
    ['What about the following Sunday?', 'october 18, 2026'],
    ['What about the following Saturday?', 'october 24, 2026'], // strictly after, never the same day
    ['Rides the next Friday?', 'october 23, 2026'],
  ])('%s', (query, expected) => {
    expect(guestOffsetDateConcept(query, previous, CLOCK)?.terms).toContain(expected)
    const flat = guestRetrievalConcepts(query, previous, CLOCK).concepts.flat()
    expect(flat).toContain(expected)
    expect(flat).not.toContain('october 17, 2026')
  })

  it('crosses month and year ends', () => {
    expect(guestOffsetDateConcept('The next day?', 'Open December 31, 2026?', CLOCK)?.terms).toContain(
      'january 1, 2027',
    )
    expect(guestOffsetDateConcept('The next day?', 'Open February 28, 2028?')?.terms).toContain(
      'february 29, 2028',
    )
  })

  it.each([
    ['What about the next day?', 'Open October 17 or October 18, 2026?'], // two prior dates
    ['What about the next day?', 'Open October 17 and October 18, 2026?'],
    ['What about the next day?', 'Between October 17 and October 19, 2026?'],
    ['What about the next day?', 'What time does the arcade close?'], // no prior date
    ['What about the next day?', null], // an assistant-only date is not a visitor date
    ['What about the next day?', 'Not October 17, 2026.'],
    ['What about the day after the fireworks?', previous],
    ['The next day after October 20?', previous], // its own boundary date
    ['What about the next week?', previous],
    ['What about next Sunday?', previous], // relative to today or the visit? unclear
    ['The day before?', previous],
    ['What about the next day?', 'Open October 17?'], // no clock: no year
  ])('fails closed: %s / %s', (query, prior) => {
    expect(guestOffsetDateConcept(query, prior, prior === 'Open October 17?' ? null : CLOCK)).toBeNull()
  })

  it('never reads a date from assistant text', () => {
    // Only the visitor's previous message is an input; there is no assistant-text parameter.
    expect(guestRetrievalConcepts('What about the next day?', 'Is it open?', CLOCK).dateConcept).toBeNull()
  })
})

/** Applies the text filters of a Prisma-style `where`; scope fields are fictional and pass. */
function matches(row: GuestKnowledgeRow, where: unknown): boolean {
  if (!where || typeof where !== 'object') return true
  return Object.entries(where as Record<string, unknown>).every(([key, value]) => {
    if (key === 'AND') return (value as unknown[]).every((part) => matches(row, part))
    if (key === 'OR') return (value as unknown[]).some((part) => matches(row, part))
    if (key === 'title' || key === 'category' || key === 'content') {
      const contains = (value as { contains?: string }).contains
      return contains === undefined || row[key].toLowerCase().includes(contains.toLowerCase())
    }
    if (key === 'id') {
      if (typeof value === 'string') return row.id === value
      const list = (value as { in?: string[] }).in
      return list ? list.includes(row.id) : true
    }
    return true
  })
}

function filteringReader(rows: GuestKnowledgeRow[]) {
  const calls: unknown[] = []
  return {
    calls,
    reader: {
      venueKnowledgeEntry: {
        findMany: async (args: { where: unknown; take?: number }) => {
          calls.push(args.where)
          // Recency order puts the off-date rows first, as in the real ordered query.
          return rows.filter((row) => matches(row, args.where)).slice(0, args.take ?? rows.length)
        },
      },
    },
  }
}

function row(id: string, title: string, content: string, reviewed: string): GuestKnowledgeRow {
  return {
    id,
    title,
    content,
    category: 'Hours',
    sourceType: 'FOUNDER_PROVIDED',
    sourceName: 'Fictional schedule',
    sourceUrl: null,
    lastReviewedAt: new Date(reviewed),
    updatedAt: new Date(reviewed),
  }
}

describe('database selection admits the dated record', () => {
  // 70 recent off-date "hours" records saturate the broad and per-concept bounds.
  const offDate = Array.from({ length: 70 }, (_, index) =>
    row(
      `off-${index}`,
      `Moon Harbor rides hours ${index}`,
      `Hours: rides noon to 6pm Friday, December ${(index % 28) + 1}, 2026. Rides and boardwalk hours vary.`,
      '2026-10-11T00:00:00Z',
    ),
  )
  const dated = row(
    'dated-oct',
    'Moon Harbor October 2026 schedule',
    'Hours: 11am to 9pm Saturday, October 17, 2026. Hours: 11am to 6pm Sunday, October 18, 2026.',
    '2026-09-01T00:00:00Z',
  )
  const sources = [...offDate, dated]

  it('selects and ranks the exact-date record for a first-turn date', async () => {
    const { reader, calls } = filteringReader(sources)
    const result = await retrieveGuestKnowledge({
      reader,
      query: 'What hours are the Moon Harbor boardwalk rides running on Saturday, October 17, 2026?',
      tenantId: 'fictional-tenant',
      venueId: 'fictional-venue',
      includeSecondLayer: false,
      queryEmbedding: null,
      asOf: CLOCK,
    })
    expect(result.entries.map(({ id }) => id)).toContain('dated-oct')
    expect(result.entries[0]!.id).toBe('dated-oct')
    // A dedicated date-filtered query exists and admits only rows naming the date.
    const datedCalls = calls.filter((where) => JSON.stringify(where).includes('october 17, 2026'))
    expect(datedCalls.length).toBeGreaterThan(0)
  })

  it('without the date the dated record is crowded out (control)', async () => {
    const { reader } = filteringReader(sources)
    const result = await retrieveGuestKnowledge({
      reader,
      query: 'What hours are the Moon Harbor boardwalk rides running?',
      tenantId: 'fictional-tenant',
      venueId: 'fictional-venue',
      includeSecondLayer: false,
      queryEmbedding: null,
      asOf: CLOCK,
    })
    expect(result.entries.map(({ id }) => id)).not.toContain('dated-oct')
  })

  it('admits the offset day record from "the next day"', async () => {
    const { reader } = filteringReader(sources)
    const result = await retrieveGuestKnowledge({
      reader,
      query: 'What about the next day?',
      previousQuery: 'What hours are the Moon Harbor rides running on Saturday, October 17, 2026?',
      tenantId: 'fictional-tenant',
      venueId: 'fictional-venue',
      includeSecondLayer: false,
      queryEmbedding: null,
      asOf: CLOCK,
    })
    expect(result.entries.map(({ id }) => id)).toContain('dated-oct')
  })

  it('does not admit a dated record when the year is unclear', async () => {
    const { reader, calls } = filteringReader(sources)
    await retrieveGuestKnowledge({
      reader,
      query: 'What hours are the rides running on June 17?',
      tenantId: 'fictional-tenant',
      venueId: 'fictional-venue',
      includeSecondLayer: false,
      queryEmbedding: null,
      asOf: CLOCK,
    })
    expect(calls.some((where) => /june 17, 20\d\d/u.test(JSON.stringify(where)))).toBe(false)
  })
})
