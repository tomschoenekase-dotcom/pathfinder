import { describe, expect, it } from 'vitest'

import {
  GUEST_RECORD_DATE_RULE,
  guestRecordDate,
  guestRecordDatesEnabled,
} from './guest-record-dates'
import { buildGuestVenueGuidePrompt, type GuestVenueDirectory } from './guest-venue-directory'
import { buildVenueSystemPromptParts } from './venue-context'

const older = {
  id: 'admission-a',
  title: 'Admission',
  category: 'Tickets',
  content: 'Adults $14, children $8.',
  sourceUrl: null,
  updatedAt: new Date('2026-02-10T12:00:00Z'),
}
const newer = {
  ...older,
  id: 'admission-b',
  title: 'Ticket prices',
  content: 'Adults $17, children $9.',
  updatedAt: new Date('2026-09-28T12:00:00Z'),
}
const directory = {
  knowledge: [older, newer],
  places: [],
  incomplete: false,
} as unknown as GuestVenueDirectory

describe('guest record dates', () => {
  it('is off unless explicitly on and formats valid dates only', () => {
    expect(guestRecordDatesEnabled({})).toBe(false)
    expect(guestRecordDatesEnabled({ GUEST_CHAT_RECORD_DATES: 'yes' })).toBe(false)
    expect(guestRecordDatesEnabled({ GUEST_CHAT_RECORD_DATES: ' ON ' })).toBe(true)
    expect(guestRecordDate(new Date('2026-09-28T23:30:00Z'))).toBe('2026-09-28')
    expect(guestRecordDate('2026-02-10T00:00:00.000Z')).toBe('2026-02-10')
    expect(guestRecordDate('not a date')).toBeNull()
    expect(guestRecordDate(null)).toBeNull()
  })

  it('shows each topic date and the currency rule in the full guide only when on', () => {
    const off = buildGuestVenueGuidePrompt(directory, { currentDate: '2026-10-18' }).prompt
    expect(off).not.toContain('updated=')
    expect(off).not.toContain(GUEST_RECORD_DATE_RULE)
    const on = buildGuestVenueGuidePrompt(directory, {
      currentDate: '2026-10-18',
      recordDates: true,
    }).prompt
    expect(on).toContain('<topic title="Admission" category="Tickets" updated="2026-02-10">')
    expect(on).toContain('<topic title="Ticket prices" category="Tickets" updated="2026-09-28">')
    expect(on).toContain(GUEST_RECORD_DATE_RULE)
    // Only the date and rule are added; both records keep their full text.
    expect(on).toContain('Adults $14, children $8.')
    expect(on).toContain('Adults $17, children $9.')
  })

  it('shows dates on knowledge base entries only when on', () => {
    const base = {
      venue: { name: 'Fictional Hall', description: null, category: 'museum' },
      relevantPlaces: [],
      userLat: null,
      userLng: null,
      knowledgeEntries: [older, newer],
    } as unknown as Parameters<typeof buildVenueSystemPromptParts>[0]
    const off = buildVenueSystemPromptParts(base).dynamicPart
    expect(off).not.toContain('Updated: 2026')
    const on = buildVenueSystemPromptParts({ ...base, recordDates: true }).dynamicPart
    expect(on).toContain('Ticket prices\nUpdated: 2026-09-28\nAdults $17')
    expect(on).toContain(GUEST_RECORD_DATE_RULE)
  })
})
