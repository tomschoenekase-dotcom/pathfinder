import { describe, expect, it } from 'vitest'

import { GUEST_DATED_TITLE_RULE } from './guest-event-dates'
import { buildVenueSystemPromptParts } from './venue-context'

const base = {
  venue: { name: 'Fictional Gardens', description: null, category: 'garden' },
  relevantPlaces: [],
  userLat: null,
  userLng: null,
  currentDate: '2026-10-18',
} as unknown as Parameters<typeof buildVenueSystemPromptParts>[0]
const entry = (id: string, title: string, content: string) => ({
  id,
  title,
  category: 'Events',
  content,
  sourceUrl: null,
})

describe('dated titles in retrieved knowledge entries', () => {
  it('marks an old-titled entry whose text names this year, and adds the rule once', () => {
    const { dynamicPart } = buildVenueSystemPromptParts({
      ...base,
      knowledgeEntries: [
        entry('a', 'Harvest Nights 2025', 'Returns October 23, 24, 30 and 31, 2026.'),
        entry('b', 'Garden tours', 'Daily at 11 am.'),
      ],
    })
    expect(dynamicPart).toContain(
      '[Events] Harvest Nights 2025\ntitle_year_passed="2025"\nReturns October 23, 24, 30 and 31, 2026.',
    )
    expect(dynamicPart).toContain('[Events] Garden tours\nDaily at 11 am.')
    expect(dynamicPart.split(GUEST_DATED_TITLE_RULE)).toHaveLength(2)
  })

  it('adds nothing when no entry needs a marker or no current date is known', () => {
    const plain = buildVenueSystemPromptParts({
      ...base,
      knowledgeEntries: [entry('b', 'Garden tours', 'Daily at 11 am.')],
    }).dynamicPart
    expect(plain).not.toContain('title_year_passed')
    expect(plain).not.toContain(GUEST_DATED_TITLE_RULE)
    const withoutDate: Partial<typeof base> = { ...base }
    delete withoutDate.currentDate
    const undated = buildVenueSystemPromptParts({
      ...(withoutDate as typeof base),
      knowledgeEntries: [entry('a', 'Harvest Nights 2025', 'Returns October 23, 2026.')],
    }).dynamicPart
    expect(undated).not.toContain('title_year_passed')
  })
})
