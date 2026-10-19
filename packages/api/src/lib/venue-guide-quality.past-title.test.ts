import { describe, expect, it } from 'vitest'

import { guideQualityWarnings } from './venue-guide-quality'

const today = '2026-10-18'
const pastTitleWarnings = (title: string, content: string, category = 'Events') =>
  guideQualityWarnings(
    [{ kind: 'knowledge', path: 'knowledgeEntries.0', title, category, content }],
    {
      today,
    },
  ).filter((w) => w.code === 'GUIDE_QUALITY_PAST_TITLE_YEAR')

describe('past title year authoring check', () => {
  it('flags a passed-year title whose text dates a newer run, with the title path', () => {
    for (const content of [
      'Returns October 23, 24, 30 and 31, 2026, from 6 pm to 9 pm.',
      'The festival ran October 30 and 31, 2025. Checked October 18, 2026 against the official site.',
    ]) {
      const warnings = pastTitleWarnings('Lantern Festival 2025', content)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatchObject({ path: 'knowledgeEntries.0.title' })
      expect(warnings[0]!.message).toContain('Lantern Festival 2025')
      expect(warnings[0]!.message.length).toBeLessThanOrEqual(600)
    }
  })

  it('stays quiet for archived events, current titles and incidental years', () => {
    expect(pastTitleWarnings('Lantern Festival 2025', 'It ran October 30 and 31, 2025.')).toEqual(
      [],
    )
    expect(pastTitleWarnings('Lantern Festival 2026', 'Returns October 30, 2026.')).toEqual([])
    expect(
      pastTitleWarnings('Spring Fest 2024', 'Held April 5 to 7, 2024. (c) 2026 Example Park.'),
    ).toEqual([])
  })
})
