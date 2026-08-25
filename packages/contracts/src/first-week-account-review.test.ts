import { describe, expect, it } from 'vitest'

import { FirstWeekAccountReviewSnapshot } from './first-week-account-review'

const base = {
  version: 1 as const,
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  releaseMilestoneEventId: '11111111-1111-4111-8111-111111111111',
  milestone: 'DAY_1' as const,
  releaseAt: '2026-08-20T00:00:00.000Z',
  dueAt: '2026-08-21T00:00:00.000Z',
  metrics: {
    publicSessions: 0,
    guestQuestions: 0,
    lowConfidenceInsights: 0,
    knowledgeGapInsights: 0,
    negativeFeedback: 0,
    supportRequestsCreated: 0,
    aiRequests: 0,
    failedAiRequests: 0,
    estimatedAiCostUsd: '0',
  },
}

describe('FirstWeekAccountReviewSnapshot', () => {
  it('accepts privacy-bounded no-action evidence without a draft', () => {
    expect(
      FirstWeekAccountReviewSnapshot.parse({
        ...base,
        disposition: 'NO_ACTION',
        draftSubject: null,
        draftBody: null,
        draftReason: null,
      }),
    ).toMatchObject({ disposition: 'NO_ACTION' })
  })

  it('requires complete draft evidence when a review is draft-ready', () => {
    expect(() =>
      FirstWeekAccountReviewSnapshot.parse({
        ...base,
        disposition: 'DRAFT_READY',
        draftSubject: 'Check-in',
        draftBody: null,
        draftReason: null,
      }),
    ).toThrow()
  })

  it('rejects raw or undeclared fields from the immutable snapshot', () => {
    expect(() =>
      FirstWeekAccountReviewSnapshot.parse({
        ...base,
        disposition: 'NO_ACTION',
        draftSubject: null,
        draftBody: null,
        draftReason: null,
        rawConversation: 'private visitor text',
      }),
    ).toThrow()
  })
})
