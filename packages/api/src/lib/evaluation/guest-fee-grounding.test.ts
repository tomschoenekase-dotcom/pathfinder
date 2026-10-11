import { describe, expect, it } from 'vitest'

import { buildVenueSystemPromptParts } from '../venue-context'
import { GUEST_FEE_GROUNDING_CASES } from './guest-fee-grounding-cases'

describe('fee grounding prompt regressions', () => {
  it.each(GUEST_FEE_GROUNDING_CASES)(
    'retains item-specific evidence and grounding for $id',
    (scenario) => {
      const { staticPart, dynamicPart } = buildVenueSystemPromptParts({
        venue: {
          name: 'Riverbend Heritage Center',
          description: null,
          category: 'museum',
          guideNotes: null,
        },
        relevantPlaces: [],
        knowledgeEntries: scenario.knowledgeEntries,
        userLat: null,
        userLng: null,
      })
      // Actual production context construction must preserve both the unknown and positive
      // controls. These tests establish prompt delivery, not model compliance.
      for (const fact of scenario.knowledgeEntries)
        expect(staticPart + dynamicPart).toContain(fact.content)
      expect(staticPart).toContain('explicitly identify the unknown cost or coverage')
      expect(staticPart).toContain(
        'separately give confirmed prices, free options, discounts and benefits confidently',
      )
      expect(staticPart).toContain(
        'An explicitly stated charge remains a charge even if its amount is unknown',
      )
      expect(staticPart).toContain('correct an earlier unsupported cost or coverage claim')
      expect(staticPart).toContain('unconfirmed costs or benefits')
    },
  )
})
