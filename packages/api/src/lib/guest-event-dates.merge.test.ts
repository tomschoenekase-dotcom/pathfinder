import { describe, expect, it } from 'vitest'

import { GUEST_DATED_TITLE_RULE } from './guest-event-dates'
import { buildGuestVenueDirectoryPrompt, type GuestVenueDirectory } from './guest-venue-directory'

const today = '2026-10-18'
const place = {
  id: 'p1',
  name: 'Lantern Festival 2025',
  type: 'attraction',
  itemType: 'activity',
  areaName: null,
  shortDescription: 'A lantern trail along the lake.',
  longDescription: null as string | null,
}
const topic = (content: string) => ({
  id: 'k1',
  title: 'Lantern Festival 2025',
  category: 'Events',
  content,
  sourceUrl: null,
})
const directoryPrompt = (content: string, placeChanges: Partial<typeof place> = {}) =>
  buildGuestVenueDirectoryPrompt(
    {
      knowledge: [topic(content)],
      places: [{ ...place, ...placeChanges }],
      incomplete: false,
    } as unknown as GuestVenueDirectory,
    { currentDate: today },
  )

describe('dated titles merged into a same-name place line', () => {
  it('keeps the marker, the dated sentence and the trusted rule for an uncertain topic', () => {
    const prompt = directoryPrompt(
      'The festival ran October 30 and 31, 2025. Returns October 23, 24, 30 and 31, 2026.',
    )
    expect(prompt).toContain(
      '- Lantern Festival 2025 (activity, attraction) (title_year_passed="2025"): A lantern trail along the lake. Returns October 23, 24, 30 and 31, 2026.',
    )
    expect(prompt.indexOf(GUEST_DATED_TITLE_RULE)).toBeGreaterThan(-1)
    expect(prompt.indexOf(GUEST_DATED_TITLE_RULE)).toBeLessThan(
      prompt.indexOf('<untrusted_venue_data>'),
    )
    expect(prompt).not.toContain('over; never present as current')
  })

  it('keeps a place description with a source-check date without asserting a new run', () => {
    const prompt = directoryPrompt(
      'The festival ran October 30 and 31, 2025. Checked October 18, 2026 against the official site.',
    )
    expect(prompt).toContain(
      '(title_year_passed="2025"): A lantern trail along the lake. Checked October 18, 2026 against the official site.',
    )
    expect(prompt).not.toContain('over; never present as current')
    expect(prompt).toContain(GUEST_DATED_TITLE_RULE)
  })

  it('uses the long place description if there is no short description', () => {
    const prompt = directoryPrompt('Returns October 2026.', {
      shortDescription: '',
      longDescription: 'A lantern trail along the lake.',
    })
    expect(prompt).toContain(
      '(title_year_passed="2025"): A lantern trail along the lake. Returns October 2026.',
    )
  })

  it('retains date evidence when both descriptions would exceed the compact line bound', () => {
    const prompt = directoryPrompt('Returns October 2026.', {
      shortDescription: `A trail ${'along the lake '.repeat(12)}ends here.`,
    })
    expect(prompt).toContain('(title_year_passed="2025"): Returns October 2026.')
    expect(prompt).not.toContain('A trail')
  })

  it('does not repeat a place description that is already the dated sentence', () => {
    const prompt = directoryPrompt('Returns October 2026.', {
      shortDescription: 'Returns October 2026.',
    })
    expect(prompt.split('Returns October 2026.')).toHaveLength(2)
  })

  it('never lets an ended topic describe the place; the topic stays in the past list', () => {
    const prompt = directoryPrompt('The festival ran October 30 and 31, 2025.')
    expect(prompt).toContain(
      '- Lantern Festival 2025 (activity, attraction): A lantern trail along the lake.',
    )
    expect(prompt).not.toContain('The festival ran October 30 and 31, 2025.')
    expect(prompt).toMatch(/Past dated events[^\n]*\n- Lantern Festival 2025/u)
    expect(prompt).not.toContain(GUEST_DATED_TITLE_RULE)
  })
})
