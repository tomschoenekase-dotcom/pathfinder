/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ProspectOutreachHistorySummary } from './ProspectOutreachHistorySummary'
import type { ProspectOutreachHistoryProjection } from '@pathfinder/db'
;(globalThis as typeof globalThis & { React: typeof React }).React = React
const history: ProspectOutreachHistoryProjection = {
  canonicalOrganizationId: 'fictional-org',
  organizationIds: ['fictional-org'],
  coldEmailCount: null,
  lastColdEmailAt: null,
  firstHumanReply: 'otherUnknown',
  relationship: 'deferred',
  nextEligibleAt: null,
  eligibility: 'hold',
  eligibilityReason: 'history_incomplete',
  contactHealth: 'unverified',
  historyComplete: false,
  reasons: ['history_incomplete', 'contact_unverified'],
}
afterEach(cleanup)
describe('outreach history display', () => {
  it('keeps unknown history visible and explains codes in plain language', () => {
    render(<ProspectOutreachHistorySummary history={history} detail />)
    expect(screen.getByText(/Unknown cold-email count/)).toBeTruthy()
    expect(screen.getAllByText(/Outreach history needs review/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Needs review', { selector: 'dd' }).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('history_incomplete')
  })
  it('never substitutes activity totals for missing history', () => {
    render(<ProspectOutreachHistorySummary />)
    expect(screen.getByText(/Outreach history unavailable/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('0 sent')
  })
})
