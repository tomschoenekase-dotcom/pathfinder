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
      weekend ? `Hours: noon–7pm ${date}, for Pier rides.` : `Closed: Pier rides ${date}.`,
      `Hours: 11am–9pm ${date}, for Tide Arcade and Lantern Hall.`,
      `Hours: 11am–midnight ${date}, for Harbor Lanes.`,
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
      'Hours: noon–7pm Sunday, October 11, 2031, for Pier rides.',
      'Closed: Pier rides Monday, October 12, 2031.',
      'Hours: 11am–9pm Monday, October 12, 2031, for Tide Arcade and Lantern Hall.',
      'Hours: 11am–midnight Monday, October 12, 2031, for Harbor Lanes.',
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
