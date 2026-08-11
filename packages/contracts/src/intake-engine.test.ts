import { describe, expect, it } from 'vitest'

import { IntakeProposal, IntakeSource, WebsiteIntakeBounds } from './intake-engine'

describe('intake engine contracts', () => {
  it('keeps website intake bounded and draft-only', () => {
    const bounds = WebsiteIntakeBounds.parse({ allowedHosts: ['example.org'] })
    expect(bounds.maxPages).toBe(25)
    expect(bounds.respectRobots).toBe(true)
    expect(bounds.publishMode).toBe('DRAFT_ONLY')
    expect(WebsiteIntakeBounds.safeParse({ ...bounds, maxPages: 101 }).success).toBe(false)
  })

  it('never represents an intake proposal as auto-published', () => {
    expect(
      IntakeProposal.safeParse({
        runId: 'run-1',
        status: 'AWAITING_REVIEW',
        sourceIds: ['source-1'],
        autoPublish: true,
      }).success,
    ).toBe(false)
  })

  it('does not allow interview recording to be enabled without the owner policy decision', () => {
    expect(
      IntakeSource.safeParse({
        id: 'source-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        kind: 'INTERVIEW',
        displayName: 'Operations interview',
        capturedAt: '2026-08-11T19:00:00.000Z',
        consentToRecord: true,
      }).success,
    ).toBe(false)
  })
})
