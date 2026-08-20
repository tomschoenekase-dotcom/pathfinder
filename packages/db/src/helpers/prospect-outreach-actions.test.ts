import { describe, expect, it } from 'vitest'

import {
  detectProspectDraftEscalations,
  PROSPECT_OUTREACH_MAX_BATCH,
  PROSPECT_OUTREACH_MAX_COHORT,
  PROSPECT_PLAYBOOK_VERSION,
} from './prospect-outreach-actions'

describe('prospect outreach policy', () => {
  it('flags business commitments and strategic prospects for explicit human review', () => {
    expect(
      detectProspectDraftEscalations({
        subject: 'A custom Torchiko plan',
        textBody:
          'We will build a custom feature for $25 per month and come to the venue for in-person onboarding.',
        relationshipTier: 'STRATEGIC',
      }),
    ).toEqual(['custom-commitment', 'pricing', 'strategic-prospect', 'travel'])
  })

  it('does not flag normal factual outreach', () => {
    expect(
      detectProspectDraftEscalations({
        subject: 'Torchiko for the museum',
        textBody:
          'Visitors could ask what they should see with thirty minutes left. I would be happy to answer questions.',
        relationshipTier: 'STANDARD',
      }),
    ).toEqual([])
  })

  it('keeps cohort and release sizes bounded', () => {
    expect(PROSPECT_OUTREACH_MAX_COHORT).toBe(5000)
    expect(PROSPECT_OUTREACH_MAX_BATCH).toBe(500)
    expect(PROSPECT_PLAYBOOK_VERSION).toMatch(/^torchiko-email-playbook-/u)
  })
})
