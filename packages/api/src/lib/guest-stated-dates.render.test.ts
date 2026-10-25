import { describe, expect, it } from 'vitest'
import { GUEST_STATED_DATES_RULE } from './guest-stated-dates'
import {
  buildGuestVenueDirectoryPrompt,
  buildGuestVenueGuidePrompt,
  type GuestVenueDirectory,
} from './guest-venue-directory'
import { renderGuestVenueIndex } from './guest-venue-index'
import { buildVenueSystemPromptParts } from './venue-context'

// Fictional records shaped like authored venue topics: dates in the body, none in the title.
const base = { sourceType: 'MANUAL', sourceName: null, sourceUrl: null }
const ended = {
  ...base,
  id: 'lanterns',
  title: 'Moonbeam Lantern Nights',
  category: 'Seasonal events',
  content:
    'Moonbeam Lantern Nights runs Thursday to Sunday, October 1 to October 31, 2026, 6 pm to 10 pm.',
}
const current = {
  ...base,
  id: 'hours',
  title: 'Hours and season',
  category: 'Hours',
  content: 'Hours: daily, 10 am to 4 pm, September 8, 2026 to May 28, 2027.',
}
const yearly = {
  ...base,
  id: 'garden',
  title: 'Garden hours',
  category: 'Hours',
  content: 'The garden opens May–October, Wednesday to Sunday, 9 am to 5 pm.',
}
const directory: GuestVenueDirectory = {
  knowledge: [ended, current, yearly],
  places: [],
  incomplete: false,
}
const asOf = '2026-11-15'

describe('stated-dates marker in guest renderers', () => {
  it('leaves every renderer byte-identical when the flag is off', () => {
    expect(
      buildGuestVenueGuidePrompt(directory, { currentDate: asOf, statedDates: false }),
    ).toEqual(buildGuestVenueGuidePrompt(directory, { currentDate: asOf }))
    expect(
      buildGuestVenueDirectoryPrompt(directory, { currentDate: asOf, statedDates: false }),
    ).toBe(buildGuestVenueDirectoryPrompt(directory, { currentDate: asOf }))
    expect(renderGuestVenueIndex(directory, { currentDate: asOf, statedDates: false })).toEqual(
      renderGuestVenueIndex(directory, { currentDate: asOf }),
    )
    const off = buildGuestVenueGuidePrompt(directory, { currentDate: asOf }).prompt
    expect(off).not.toContain('stated_dates_passed')
    expect(off).not.toContain(GUEST_STATED_DATES_RULE)
  })

  it('marks only the ended topic in the full guide and keeps its text', () => {
    const full = buildGuestVenueGuidePrompt(directory, { currentDate: asOf, statedDates: true })
    expect(full.mode).toBe('FULL')
    expect(full.prompt).toContain(
      'title="Moonbeam Lantern Nights" category="Seasonal events" stated_dates_passed="2026-10-31">',
    )
    expect(full.prompt).toContain('October 1 to October 31, 2026')
    expect(full.prompt).toContain('title="Hours and season" category="Hours">')
    expect(full.prompt).toContain('title="Garden hours" category="Hours">')
    expect(full.prompt.match(/stated_dates_passed=/gu)).toHaveLength(1)
    expect(full.prompt).toContain(GUEST_STATED_DATES_RULE)
    // Never hidden: the record still counts as carried in full.
    expect(full.recordIds.has('knowledge:lanterns')).toBe(true)
  })

  it('adds no rule when nothing is marked', () => {
    const prompt = buildGuestVenueGuidePrompt(
      { knowledge: [current, yearly], places: [], incomplete: false },
      { currentDate: asOf, statedDates: true },
    ).prompt
    expect(prompt).not.toContain(GUEST_STATED_DATES_RULE)
  })

  it('marks directory, evidence index and knowledge-base lines for large or evidence venues', () => {
    const summary = buildGuestVenueDirectoryPrompt(directory, {
      currentDate: asOf,
      statedDates: true,
    })
    expect(summary).toContain('Moonbeam Lantern Nights (stated_dates_passed="2026-10-31")')
    expect(summary).toContain(GUEST_STATED_DATES_RULE)
    const forced = buildGuestVenueGuidePrompt(directory, {
      currentDate: asOf,
      statedDates: true,
      maxFullChars: 10,
    })
    expect(forced.mode).toBe('DIRECTORY')
    expect(forced.prompt).toContain('(stated_dates_passed="2026-10-31")')

    const index = buildGuestVenueGuidePrompt(directory, {
      currentDate: asOf,
      statedDates: true,
      strategy: 'evidence',
    }).prompt
    expect(index).toContain(
      'Topic: [Seasonal events] Moonbeam Lantern Nights (stated_dates_passed="2026-10-31")',
    )
    expect(index).toContain(GUEST_STATED_DATES_RULE)

    const parts = (statedDates: boolean) =>
      buildVenueSystemPromptParts({
        venue: {
          name: 'Fictional Moonbeam Park',
          description: null,
          category: 'park',
          guideNotes: null,
        },
        relevantPlaces: [],
        knowledgeEntries: [ended, current],
        userLat: null,
        userLng: null,
        currentDate: asOf,
        statedDates,
      })
    const on = parts(true)
    const text = on.staticPart + on.dynamicPart
    expect(text).toContain(
      '[Seasonal events] Moonbeam Lantern Nights\nstated_dates_passed="2026-10-31"\n',
    )
    expect(text).toContain(GUEST_STATED_DATES_RULE)
    expect(text.match(/stated_dates_passed=/gu)).toHaveLength(1)
    const off = parts(false)
    expect(off.staticPart + off.dynamicPart).not.toContain('stated_dates_passed')
  })
})
