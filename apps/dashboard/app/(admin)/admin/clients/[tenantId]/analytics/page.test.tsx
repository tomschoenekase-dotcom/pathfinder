/* @vitest-environment jsdom */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ getClientAnalytics: vi.fn() }))
vi.mock('../../../../../../lib/admin-caller', () => ({
  createAdminCaller: async () => ({
    admin: { getClientAnalytics: mocks.getClientAnalytics },
  }),
}))

import AdminClientAnalyticsPage from './page'

describe('AdminClientAnalyticsPage first-week learning', () => {
  it('renders aggregate evidence and marks communication as unsent draft-only work', async () => {
    mocks.getClientAnalytics.mockResolvedValue({
      tenant: { id: 'tenant_1', name: 'Museum Group', slug: 'museum-group' },
      stats: { totalSessions: 4, totalMessages: 9, uniqueVisitors: 3 },
      questionClusters: [],
      recentSessions: [],
      firstWeekReviews: [
        {
          id: 'review_1',
          venueId: 'venue_1',
          milestone: 'DAY_3',
          releaseAt: new Date('2026-08-20T00:00:00.000Z'),
          dueAt: new Date('2026-08-23T00:00:00.000Z'),
          metrics: {
            publicSessions: 4,
            guestQuestions: 7,
            lowConfidenceInsights: 1,
            knowledgeGapInsights: 2,
            negativeFeedback: 0,
            supportRequestsCreated: 0,
            aiRequests: 8,
            failedAiRequests: 0,
            estimatedAiCostUsd: '0.03',
          },
          disposition: 'DRAFT_READY',
          draftSubject: 'A quick first-week check-in',
          draftBody: 'How has the experience felt for your team?',
          draftReason: 'Review before sending: 2 knowledge-gap signals.',
          createdAt: new Date('2026-08-23T00:01:00.000Z'),
          venue: { name: 'North Museum' },
          communicationAuthority: 'draft-only',
        },
      ],
    })

    const page = await AdminClientAnalyticsPage({
      params: Promise.resolve({ tenantId: 'tenant_1' }),
    })
    const html = renderToStaticMarkup(page)

    expect(html).toContain('First-week learning')
    expect(html).toContain('Day 3 · North Museum')
    expect(html).toContain('Knowledge gaps')
    expect(html).toContain('Draft only — nothing has been sent')
    expect(html).toContain('A quick first-week check-in')
    expect(html).not.toContain('recipient')
    expect(html).toContain('grid-cols-2')
    expect(html).toContain('xl:grid-cols-2')
    document.body.innerHTML = html
    const reviewSection = document.querySelector('#first-week-reviews')
    expect(reviewSection).not.toBeNull()
    expect(
      (
        await axe.run(reviewSection!, {
          rules: { 'color-contrast': { enabled: false } },
        })
      ).violations,
    ).toEqual([])
  })

  it('keeps a quiet empty state before a release reaches a review milestone', async () => {
    mocks.getClientAnalytics.mockResolvedValue({
      tenant: { id: 'tenant_1', name: 'Museum Group', slug: 'museum-group' },
      stats: { totalSessions: 0, totalMessages: 0, uniqueVisitors: 0 },
      questionClusters: [],
      recentSessions: [],
      firstWeekReviews: [],
    })
    const page = await AdminClientAnalyticsPage({
      params: Promise.resolve({ tenantId: 'tenant_1' }),
    })
    const html = renderToStaticMarkup(page)
    expect(html).toContain('Reviews appear automatically')
    expect(html).not.toContain('Review internal draft')
  })

  it('renders bounded conversation summaries and routes transcript review to the scoped history surface', async () => {
    mocks.getClientAnalytics.mockResolvedValue({
      tenant: { id: 'tenant_1', name: 'Museum Group', slug: 'museum-group' },
      stats: { totalSessions: 1, totalMessages: 2400, uniqueVisitors: 1 },
      questionClusters: [],
      firstWeekReviews: [],
      recentSessions: [
        {
          id: 'session_1',
          venueId: 'venue_1',
          startedAt: new Date('2026-08-27T12:00:00.000Z'),
          lastActiveAt: new Date('2026-08-27T13:00:00.000Z'),
          visitorId: 'visitor_1234567890',
          venue: { name: 'North Museum' },
          messageCount: 1200,
        },
      ],
    })

    const page = await AdminClientAnalyticsPage({
      params: Promise.resolve({ tenantId: 'tenant_1' }),
    })
    const html = renderToStaticMarkup(page)

    expect(html).toContain('1200 guest messages')
    expect(html).toContain('North Museum')
    expect(html).toContain('Review transcript')
    expect(html).toContain('/admin/clients/tenant_1/venues/venue_1/chatlogs/session_1')
    expect(html).not.toContain('Where are the bathrooms?')
  })
})
