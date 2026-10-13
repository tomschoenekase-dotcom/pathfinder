import { describe, expect, it, vi } from 'vitest'

import {
  guestRequestedCalendarDays,
  retrieveGuestKnowledge,
  type GuestKnowledgeRow,
} from './guest-knowledge-retrieval'

// Fictional pier calendar: rides close on weekdays while the arcade and lanes stay open.
const WEEKDAYS = ['Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday']
const calendar = [
  'These dated hours apply to Harbor Lights Pier. Use the exact date and facility below.',
  ...Array.from({ length: 20 }, (_, index) => {
    const day = index + 1
    const date = `${WEEKDAYS[index % 7]}, October ${day}, 2031`
    const weekend = index % 7 === 2 || index % 7 === 3
    return [
      weekend ? `Hours: noonâ€“7pm ${date}, for Pier rides.` : `Closed: Pier rides ${date}.`,
      `Hours: 11amâ€“9pm ${date}, for Tide Arcade and Lantern Hall.`,
      `Hours: 11amâ€“midnight ${date}, for Harbor Lanes.`,
    ].join('\n')
  }),
].join('\n')

function row(id: string, title: string, content: string): GuestKnowledgeRow {
  return {
    id,
    title,
    content,
    category: 'Hours',
    sourceType: 'FOUNDER_PROVIDED',
    sourceName: 'Pier calendar',
    sourceUrl: null,
    updatedAt: new Date('2031-09-01T00:00:00Z'),
    lastReviewedAt: null,
  }
}

async function retrieve(query: string, currentDate?: string) {
  // Eleven other hour records shrink each entry's share of the shared content budget.
  const others = Array.from({ length: 11 }, (_, index) =>
    row(`other-${index}`, `Lantern Hall hours ${index}`, `Lantern Hall hours note ${index}.`),
  )
  const findMany = vi
    .fn()
    .mockResolvedValue([row('pier-october', 'Pier October hours', calendar), ...others])
  const result = await retrieveGuestKnowledge({
    reader: { venueKnowledgeEntry: { findMany } },
    query,
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    includeSecondLayer: false,
    queryEmbedding: null,
    now: () => 10,
    ...(currentDate ? { currentDate } : {}),
  })
  return result.entries.find((entry) => entry.id === 'pier-october')!
}

describe('requested calendar days', () => {
  it.each([
    ['For October 11 and 12, 2031, compare ride and arcade hours.', ['october 11', 'october 12']],
    ['Hours Oct 11-13?', ['october 11', 'october 12', 'october 13']],
    ['What about Sept. 3rd and 4th', ['september 3', 'september 4']],
    ['Is the arcade open on October 1?', ['october 1']],
    ['Can I bring 2 kids in May', []],
    ['What are the hours on 10/12?', []],
  ])('reads %s', (query, days) => {
    expect(guestRequestedCalendarDays(query)).toEqual(days)
  })

  it('anchors today and tomorrow to the venue date only when supplied', () => {
    expect(guestRequestedCalendarDays('Are rides open today or tomorrow?', '2031-10-31')).toEqual([
      'october 31',
      'november 1',
    ])
    expect(guestRequestedCalendarDays('Are rides open today?')).toEqual([])
  })
})

describe('long dated records', () => {
  it('keeps every facility line for the requested days instead of cutting the calendar off', async () => {
    const entry = await retrieve(
      'For October 11 and 12, 2031, distinguish ride hours from the arcade and lanes.',
    )
    expect(entry.content.length).toBeLessThan(calendar.length)
    expect(entry.content).toContain('These dated hours apply to Harbor Lights Pier')
    for (const line of [
      'Hours: noonâ€“7pm Sunday, October 11, 2031, for Pier rides.',
      'Closed: Pier rides Monday, October 12, 2031.',
      'Hours: 11amâ€“9pm Monday, October 12, 2031, for Tide Arcade and Lantern Hall.',
      'Hours: 11amâ€“midnight Monday, October 12, 2031, for Harbor Lanes.',
    ])
      expect(entry.content).toContain(line)
    expect(entry.content).not.toContain('October 1, 2031')
    expect(entry.content).not.toContain('October 13, 2031')
  })

  it('selects the venue date for today', async () => {
    const entry = await retrieve('Are the rides open today?', '2031-10-15')
    expect(entry.content).toContain('Closed: Pier rides Thursday, October 15, 2031.')
    expect(entry.content).not.toContain('October 11, 2031')
  })

  it('keeps the existing bounded excerpt when no requested day appears', async () => {
    const entry = await retrieve('When do the rides open?')
    expect(entry.content).toContain('...[source excerpt]...')
    expect(entry.content).not.toContain('October 20, 2031')
  })
})

describe('calendar context boundaries', () => {
  const filler = Array.from(
    { length: 100 },
    (_, index) =>
      `General calendar note ${index}: ordinary park information unrelated to the requested date.`,
  ).join('\n')

  async function excerpt(
    content: string,
    query = 'What are the ride hours on October 12, 2031?',
    currentDate?: string,
  ) {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        row('context-calendar', 'Pier hours and calendar', content),
        ...Array.from({ length: 11 }, (_, index) =>
          row('other-' + index, 'Lantern Hall hours', 'Lantern Hall hours note.'),
        ),
      ])
    const result = await retrieveGuestKnowledge({
      reader: { venueKnowledgeEntry: { findMany } },
      query,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      includeSecondLayer: false,
      queryEmbedding: null,
      now: () => 10,
      ...(currentDate ? { currentDate } : {}),
    })
    return result.entries.find((entry) => entry.id === 'context-calendar')!.content
  }

  it.each([
    [
      'adjacent restriction',
      [
        'Hours: noon-7pm October 12, 2031 for Pier rides.',
        'Private event only; rides are closed to ordinary admission guests.',
      ],
    ],
    [
      'governing year',
      [
        'ARCHIVE: the following schedule is for 2030 only, not 2031.',
        'Hours: noon-7pm October 12 for Pier rides.',
        'CURRENT 2031: schedule has not been announced.',
      ],
    ],
    [
      'date heading and following facts',
      ['October 12, 2031', 'Pier rides: closed all day.', 'Tide Arcade: 11am-9pm.'],
    ],
    [
      'same-line control',
      ['Closed: Pier rides October 12, 2031.', 'Hours: 11am-9pm October 12, 2031 for Tide Arcade.'],
    ],
  ])('preserves %s in the bounded fallback', async (_name, facts) => {
    const content = ['Harbor Lights Pier visitor calendar.', ...facts, filler].join('\n')
    const actual = await excerpt(content)
    for (const fact of facts) expect(actual).toContain(fact)
    expect(actual.length).toBeLessThanOrEqual(4000)
    expect(actual.length).toBeLessThan(content.length)
  })

  it('retains same-line qualifications when a uniform calendar can be extracted', async () => {
    const qualified = calendar.replace(
      'Closed: Pier rides Monday, October 12, 2031.',
      'Closed: Pier rides Monday, October 12, 2031. Private event only; no ordinary admission.',
    )
    const actual = await excerpt(qualified)
    expect(actual).toContain('Private event only; no ordinary admission.')
    expect(actual).not.toContain('October 1, 2031')
  })

  it('does not extract a requested day from a different explicit year', async () => {
    const actual = await excerpt(calendar, 'What are the ride hours on October 12, 2032?')
    expect(actual).toContain('October 1, 2031') // Existing bounded window, not a false date match.
    expect(actual).toContain('...[source excerpt]...')
  })

  it.each([
    'What are the ride hours on October 12, 2031?',
    'Compare October 12, 2030 and October 12, 2031 ride hours.',
  ])('keeps year scope for mixed-year calendars: %s', async (query) => {
    const facts = [
      'ARCHIVE 2030: past season only.',
      'Hours: noon-7pm October 12, 2030 for Pier rides.',
      'CURRENT 2031: the following closure supersedes the archive.',
      'Closed: Pier rides October 12, 2031.',
    ]
    const actual = await excerpt(
      ['Harbor Lights Pier calendar.', ...facts, calendar].join('\n'),
      query,
    )
    for (const fact of facts) expect(actual).toContain(fact)
    expect(actual.length).toBeLessThanOrEqual(4000)
  })

  it('falls back for mixed years even in self-contained rows', async () => {
    const content = calendar.replace('October 1, 2031', 'October 1, 2030')
    const actual = await excerpt(content)
    expect(actual).toContain('October 1, 2030')
    expect(actual).toContain('October 1, 2031')
  })

  it('uses the year of tomorrow across the venue year boundary', async () => {
    const january = calendar.replaceAll('October', 'January').replaceAll('2031', '2032')
    const actual = await excerpt(january, 'Are rides open tomorrow?', '2031-12-31')
    expect(actual).toContain('January 1, 2032')
    expect(actual).not.toContain('January 2, 2032')
  })
})
