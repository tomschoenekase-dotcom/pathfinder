import { describe, expect, it } from 'vitest'

import { deriveFounderBriefing } from './attention-briefing'
import type { FounderBriefingInput } from './attention-briefing'

const page = <T>(items: T[], hasMore = false) => ({
  items,
  nextCursor: hasMore ? { createdAt: '2026-08-22T00:00:00.000Z', id: 'next' } : null,
})

function input(): FounderBriefingInput {
  return {
    limit: 10,
    lastReviewedThrough: null,
    events: page([]),
    platformEvents: page([]),
    questions: page([]),
    approvals: page([]),
    blockedAgents: page([]),
    support: page([]),
    workingAgents: page([]),
    completedAgents: page([]),
    outcomes: page([]),
  }
}

describe('founder briefing contract', () => {
  it('returns an honest versioned clear state for an empty bounded snapshot', () => {
    const result = deriveFounderBriefing(input())

    expect(result).toMatchObject({
      schemaVersion: 1,
      focus: {
        kind: 'CLEAR',
        urgency: 'NONE',
        source: { scope: 'PLATFORM', objectType: 'attention-console', objectId: null },
      },
      metrics: { decisions: 0, criticalRisks: 0, workingAgents: 0, customerItems: 0 },
      boundedSnapshot: { limit: 10, hasMore: false },
    })
  })

  it('prioritizes customer risk above platform risk, questions, approvals, and routine work', () => {
    const value = input()
    value.events = page([
      {
        id: 'event_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        eventType: 'guest-chat.provider-failure',
        severity: 'CRITICAL',
        title: 'Visitor chat is unavailable',
        summary: 'Guest turns are failing.',
        recommendedAction: 'Inspect affected turns.',
        actionRequired: true,
        lastOccurredAt: new Date('2026-08-22T12:00:00.000Z'),
      },
    ])
    value.platformEvents = page([
      {
        id: 'platform_1',
        eventType: 'crm.import.failed',
        severity: 'ERROR',
        title: 'CRM import failed',
        summary: 'Import stopped.',
        recommendedAction: null,
        actionRequired: true,
        lastOccurredAt: new Date('2026-08-22T12:00:00.000Z'),
      },
    ])
    value.questions = page([
      {
        id: 'question_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        question: 'Choose a source',
        context: null,
        blocking: true,
        agentIdentity: { name: 'Operator' },
        createdAt: new Date('2026-08-22T12:00:00.000Z'),
      },
    ])

    const result = deriveFounderBriefing(value)

    expect(result.focus).toMatchObject({
      kind: 'CUSTOMER_RISK',
      title: 'Visitor chat is unavailable',
      action: { href: '/admin/clients/tenant_1/venues/venue_1/chatlogs' },
      source: {
        scope: 'TENANT',
        objectType: 'operational-event',
        objectId: 'event_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      },
    })
    expect(result.metrics).toMatchObject({ decisions: 1, criticalRisks: 2 })
  })

  it('routes platform CRM incidents without fabricating tenant scope', () => {
    const value = input()
    value.platformEvents = page([
      {
        id: 'platform_1',
        eventType: 'crm.import.failed',
        severity: 'ERROR',
        title: 'CRM import failed',
        summary: 'Import stopped.',
        recommendedAction: null,
        actionRequired: true,
        lastOccurredAt: new Date('2026-08-22T12:00:00.000Z'),
      },
    ])

    expect(deriveFounderBriefing(value).focus).toMatchObject({
      kind: 'PLATFORM_RISK',
      action: { href: '/admin/prospects/imports' },
      source: {
        scope: 'PLATFORM',
        objectType: 'platform-operational-event',
        tenantId: null,
        venueId: null,
      },
    })
  })

  it('routes AI cost protection evidence to the tenant budget controls', () => {
    const value = input()
    value.events = page([
      {
        id: 'cost_event_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        eventType: 'ai-cost-budget.request-denied',
        severity: 'ERROR',
        title: 'AI request reached its cost limit',
        summary: 'A bounded reservation exceeded configured capacity.',
        recommendedAction: 'Review usage and reservation evidence.',
        actionRequired: true,
        lastOccurredAt: new Date('2026-08-22T12:00:00.000Z'),
      },
    ])

    expect(deriveFounderBriefing(value).focus).toMatchObject({
      kind: 'CUSTOMER_RISK',
      action: { href: '/admin/clients/tenant_1#ai-cost-budget' },
      source: { objectId: 'cost_event_1', tenantId: 'tenant_1', venueId: 'venue_1' },
    })
  })

  it('orders question, approval, blocked work, and support fallback classes deterministically', () => {
    const value = input()
    value.questions = page([
      {
        id: 'question_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        question: 'Which source is current?',
        context: 'Two records conflict.',
        blocking: true,
        agentIdentity: { name: 'Research' },
        createdAt: new Date('2026-08-22T12:00:00.000Z'),
      },
    ])
    value.approvals = page([
      {
        id: 'approval_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        proposedAction: 'Apply reviewed hours',
        riskCategory: 'MEDIUM',
        expired: false,
        agentIdentity: { name: 'Support' },
        createdAt: new Date('2026-08-22T12:00:00.000Z'),
      },
    ])
    value.blockedAgents = page([
      {
        id: 'run_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestedOperation: 'Update hours',
        status: 'AWAITING_INPUT',
        agentIdentity: { name: 'Support' },
      },
    ])
    value.support = page([
      {
        id: 'support_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        subject: 'Hours correction',
        category: 'CONTENT_CORRECTION',
        status: 'IN_REVIEW',
        updatedAt: new Date('2026-08-22T12:00:00.000Z'),
      },
    ])

    expect(deriveFounderBriefing(value).focus.kind).toBe('FOUNDER_QUESTION')
    value.questions = page([])
    expect(deriveFounderBriefing(value).focus.kind).toBe('APPROVAL')
    value.approvals = page([{ ...value.approvals.items[0]!, expired: true }])
    expect(deriveFounderBriefing(value).focus.kind).toBe('BLOCKED_WORK')
    value.blockedAgents = page([])
    expect(deriveFounderBriefing(value).focus.kind).toBe('CUSTOMER_SUPPORT')
  })

  it('discloses when any source queue is truncated', () => {
    const value = input()
    value.workingAgents = page([{ id: 'run_1' }], true)

    expect(deriveFounderBriefing(value)).toMatchObject({
      metrics: { workingAgents: 1 },
      boundedSnapshot: { limit: 10, hasMore: true },
    })
  })

  it('reports bounded changes after the operator review cursor without hiding pending work', () => {
    const value = input()
    value.lastReviewedThrough = new Date('2026-08-22T11:00:00.000Z')
    value.questions = page([
      {
        id: 'question_old',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        question: 'Still pending?',
        context: null,
        blocking: true,
        agentIdentity: { name: 'Operator' },
        createdAt: new Date('2026-08-22T10:00:00.000Z'),
      },
    ])
    value.completedAgents = page([
      {
        id: 'run_new',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestedOperation: 'Reconcile customer hours',
        createdAt: new Date('2026-08-22T11:30:00.000Z'),
        completedAt: new Date('2026-08-22T12:00:00.000Z'),
        agentIdentity: { name: 'Support operator' },
        _count: { outcomeObservations: 1 },
      },
    ])
    value.outcomes = page([
      {
        id: 'outcome_new',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentRunId: 'run_new',
        verdict: 'POSITIVE',
        taskClass: 'support',
        summary: 'Customer correction was prepared successfully.',
        createdAt: new Date('2026-08-22T12:05:00.000Z'),
        agentIdentity: { name: 'Support operator' },
      },
    ])

    const result = deriveFounderBriefing(value)
    expect(result.focus.kind).toBe('FOUNDER_QUESTION')
    expect(result.reviewState).toMatchObject({
      lastReviewedThrough: value.lastReviewedThrough,
      changesSinceLastReview: { decisions: 0, completedAgents: 1, outcomes: 1 },
      changeDigest: {
        visibleCount: 2,
        mayHaveMore: false,
        items: [{ kind: 'OUTCOME' }, { kind: 'COMPLETED_WORK' }],
      },
      hasUnreviewedChanges: true,
    })
  })
})
