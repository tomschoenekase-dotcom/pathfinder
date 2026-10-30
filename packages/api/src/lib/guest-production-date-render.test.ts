import { describe, expect, it } from 'vitest'
import { buildGuestVenueGuidePrompt, type GuestVenueDirectory } from './guest-venue-directory'
import { buildVenueSystemPromptParts } from './venue-context'
const entry = {
  id: 'season',
  title: 'Season hours',
  category: 'Hours',
  content: 'Daily, 10 am to 4 pm, September 1, 2026 to October 1, 2026.',
  sourceType: 'MANUAL',
  sourceName: null,
  sourceUrl: null,
}
const directory: GuestVenueDirectory = { knowledge: [entry], places: [], incomplete: false }
describe('production date cue rendering', () => {
  it.each([false, true])(
    'marks stated dates in full/directory paths (incomplete=%s)',
    (incomplete) => {
      const source = { ...directory, incomplete }
      const off = buildGuestVenueGuidePrompt(source, { currentDate: '2026-10-30' })
      expect(off).toEqual(
        buildGuestVenueGuidePrompt(source, { currentDate: '2026-10-30', statedDates: false }),
      )
      expect(off.prompt).not.toContain('stated_dates_passed')
      const on = buildGuestVenueGuidePrompt(source, {
        currentDate: '2026-10-30',
        statedDates: true,
      })
      expect(on.prompt).toContain('stated_dates_passed="2026-10-01"')
      expect(on.prompt).toContain('never present those as current or upcoming')
      expect(on.prompt).toContain('Season hours')
    },
  )
  it('marks retrieved whole bodies and adds today cues only to dynamic context', () => {
    const input = {
      venue: { name: 'Fictional Museum', description: null, category: 'museum', guideNotes: null },
      relevantPlaces: [],
      userLat: null,
      userLng: null,
      currentDate: '2026-10-30',
      knowledgeEntries: [entry],
    }
    const off = buildVenueSystemPromptParts(input)
    expect(off).toEqual(
      buildVenueSystemPromptParts({ ...input, statedDates: false, todayStatusCue: null }),
    )
    const on = buildVenueSystemPromptParts({
      ...input,
      statedDates: true,
      todayStatusCue: 'TODAY STATUS: closed today.',
    })
    expect(on.staticPart).toBe(off.staticPart)
    expect(on.dynamicPart).toContain('stated_dates_passed="2026-10-01"')
    expect(on.dynamicPart).toContain('TODAY STATUS: closed today.')
    expect(off.dynamicPart).not.toContain('TODAY STATUS:')
  })
})
