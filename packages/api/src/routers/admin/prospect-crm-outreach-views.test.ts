import { describe, expect, it } from 'vitest'
import type { ProspectOutreachHistoryProjection } from '@pathfinder/db'
import { matchesProspectOutreachView } from './prospect-crm-outreach-views'
const history: ProspectOutreachHistoryProjection = {
  canonicalOrganizationId: 'fictional-org',
  organizationIds: ['fictional-org'],
  coldEmailCount: 1,
  lastColdEmailAt: '2026-10-01T00:00:00Z',
  firstHumanReply: 'noReply',
  relationship: 'awaitingReply',
  nextEligibleAt: '2026-10-15T00:00:00Z',
  eligibility: 'eligible',
  eligibilityReason: 'due',
  contactHealth: 'healthy',
  historyComplete: true,
  reasons: [],
}
describe('outreach views use canonical history and gates', () => {
  it('requires an eligible unreplied cold sequence for due views', () => {
    expect(matchesProspectOutreachView(history, 'firstFollowupDue')).toBe(true)
    expect(
      matchesProspectOutreachView({ ...history, eligibility: 'hold' }, 'firstFollowupDue'),
    ).toBe(false)
    expect(matchesProspectOutreachView({ ...history, coldEmailCount: 2 }, 'finalFollowupDue')).toBe(
      true,
    )
    expect(
      matchesProspectOutreachView({ ...history, firstHumanReply: 'after1' }, 'firstFollowupDue'),
    ).toBe(false)
  })
  it('does not label missing history never contacted', () => {
    expect(
      matchesProspectOutreachView(
        { ...history, coldEmailCount: null, historyComplete: false },
        'neverContacted',
      ),
    ).toBe(false)
    expect(
      matchesProspectOutreachView(
        { ...history, coldEmailCount: null, historyComplete: false },
        'historyNeedsReview',
      ),
    ).toBe(true)
    expect(
      matchesProspectOutreachView(
        { ...history, coldEmailCount: 0, relationship: 'prospect' },
        'neverContacted',
      ),
    ).toBe(true)
  })
})
