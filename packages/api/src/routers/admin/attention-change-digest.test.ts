import { describe, expect, it } from 'vitest'

import { deriveFounderChangeDigest } from './attention-change-digest'
import type { FounderChangeDigestInput } from './attention-change-digest'

function input(): FounderChangeDigestInput {
  return {
    lastReviewedThrough: new Date('2026-08-22T11:00:00.000Z'),
    sourceHasMore: false,
    events: [],
    platformEvents: [],
    questions: [],
    approvals: [],
    completedAgents: [],
    outcomes: [],
    support: [],
  }
}

describe('founder change digest', () => {
  it('prioritizes bounded new risks and decisions above newer routine activity', () => {
    const value = input()
    value.events.push({
      id: 'event_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      eventType: 'guest-chat.provider-failure',
      severity: 'CRITICAL',
      title: 'Visitor chat is unavailable',
      summary: 'Guest turns are failing.',
      recommendedAction: 'Inspect affected turns.',
      lastOccurredAt: new Date('2026-08-22T12:00:00.000Z'),
    })
    value.questions.push({
      id: 'question_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      question: 'Which price is current?',
      context: 'Two durable sources conflict.',
      agentIdentity: { name: 'Revenue operator' },
      createdAt: new Date('2026-08-22T12:30:00.000Z'),
    })
    value.support.push({
      id: 'support_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      subject: 'Update weekend hours',
      category: 'CONTENT_CORRECTION',
      status: 'IN_REVIEW',
      updatedAt: new Date('2026-08-22T13:00:00.000Z'),
    })
    value.outcomes.push({
      id: 'outcome_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentRunId: 'run_1',
      verdict: 'POSITIVE',
      taskClass: 'support',
      summary: 'The customer accepted the correction.',
      createdAt: new Date('2026-08-22T14:00:00.000Z'),
      agentIdentity: { name: 'Support operator' },
    })
    value.completedAgents.push({
      id: 'run_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      requestedOperation: 'Prepare corrected hours',
      completedAt: new Date('2026-08-22T15:00:00.000Z'),
      createdAt: new Date('2026-08-22T13:30:00.000Z'),
      agentIdentity: { name: 'Support operator' },
      _count: { outcomeObservations: 1 },
    })

    const digest = deriveFounderChangeDigest(value)

    expect(digest).toMatchObject({ visibleCount: 5, mayHaveMore: false, limit: 5 })
    expect(digest.items.map((item) => item.kind)).toEqual([
      'CRITICAL_RISK',
      'DECISION',
      'CUSTOMER',
      'OUTCOME',
      'COMPLETED_WORK',
    ])
    expect(digest.items[0]).toMatchObject({
      action: { href: '/admin/clients/tenant_1/venues/venue_1/chatlogs' },
      source: { scope: 'TENANT', objectType: 'operational-event', objectId: 'event_1' },
    })
    expect(digest.items[3]).toMatchObject({
      action: { href: '/admin/clients/tenant_1/venues/venue_1/agents/runs/run_1' },
      source: { objectType: 'agent-outcome-observation', objectId: 'outcome_1' },
    })
  })

  it('filters reviewed activity and discloses digest or source truncation', () => {
    const value = input()
    value.questions = Array.from({ length: 7 }, (_, index) => ({
      id: `question_${index}`,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      question: `Decision ${index}`,
      context: null,
      agentIdentity: { name: 'Operator' },
      createdAt: new Date(`2026-08-22T12:0${index}:00.000Z`),
    }))
    value.questions.push({
      ...value.questions[0]!,
      id: 'question_old',
      createdAt: new Date('2026-08-22T10:00:00.000Z'),
    })

    const digest = deriveFounderChangeDigest(value)
    expect(digest).toMatchObject({ visibleCount: 7, mayHaveMore: true })
    expect(digest.items).toHaveLength(5)
    expect(digest.items.map((item) => item.title)).toEqual([
      'Decision 6',
      'Decision 5',
      'Decision 4',
      'Decision 3',
      'Decision 2',
    ])

    const sourceTruncated = deriveFounderChangeDigest({
      ...input(),
      sourceHasMore: true,
    })
    expect(sourceTruncated).toMatchObject({ visibleCount: 0, items: [], mayHaveMore: true })
  })

  it('keeps platform incidents platform-scoped', () => {
    const value = input()
    value.platformEvents.push({
      id: 'platform_1',
      eventType: 'crm.import.failed',
      severity: 'ERROR',
      title: 'CRM import failed',
      summary: 'The import stopped.',
      recommendedAction: null,
      lastOccurredAt: new Date('2026-08-22T12:00:00.000Z'),
    })

    expect(deriveFounderChangeDigest(value).items[0]).toMatchObject({
      action: { href: '/admin/prospects/imports' },
      source: {
        scope: 'PLATFORM',
        objectType: 'platform-operational-event',
        objectId: 'platform_1',
        tenantId: null,
        venueId: null,
      },
    })
  })
})
