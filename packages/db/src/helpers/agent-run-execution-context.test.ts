import { describe, expect, it } from 'vitest'

import { buildBoundedAgentRunExecutionContext } from './agent-run-execution-context'

const date = (value: string) => new Date(value)

describe('bounded agent run execution context', () => {
  it('keeps the newest current answer with provenance and excludes a superseded duplicate', () => {
    const context = buildBoundedAgentRunExecutionContext({
      id: 'run-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      attemptNumber: 2,
      scopeSnapshot: { currentStateRef: 'Venue:venue-1:v7', sourceRefs: ['Source:capacity:v3'] },
      questions: [
        {
          id: 'question-current',
          question: 'What is the approved visitor capacity?',
          answer: 'The approved visitor capacity is exactly 137.',
          category: 'venue.capacity',
          answeredAt: date('2026-09-06T18:00:00.000Z'),
          updatedAt: date('2026-09-06T18:00:00.000Z'),
          answeredById: 'admin-1',
          evidence: [{ reference: 'Source:capacity:v3' }],
          callbackMetadata: { version: 3 },
        },
        {
          id: 'question-stale',
          question: 'What is the approved visitor capacity?',
          answer: '120',
          category: 'venue.capacity',
          answeredAt: date('2026-09-05T18:00:00.000Z'),
          updatedAt: date('2026-09-05T18:00:00.000Z'),
          answeredById: 'admin-1',
          evidence: [],
          callbackMetadata: null,
        },
      ],
      messages: [
        {
          id: 'message-2',
          role: 'AGENT',
          messageType: 'RESULT',
          content: 'Earlier analysis.',
          actorId: 'agent-1',
          createdAt: date('2026-09-06T17:00:00.000Z'),
        },
        {
          id: 'message-1',
          role: 'OPERATOR',
          messageType: 'PROMPT',
          content: 'Draft a capacity notice.',
          actorId: 'admin-1',
          createdAt: date('2026-09-06T16:00:00.000Z'),
        },
      ],
    })

    expect(context).toContain('The approved visitor capacity is exactly 137.')
    expect(context).not.toContain('"answer": "120"')
    expect(context).toContain('Venue:venue-1:v7')
    expect(context).toContain('Source:capacity:v3')
    expect(context).toContain('"attemptNumber": 2')
    expect(context.indexOf('Draft a capacity notice.')).toBeLessThan(
      context.indexOf('Earlier analysis.'),
    )
    expect(context).toContain('do not grant permission')
  })

  it('marks explicit truncation and never exceeds the requested bound', () => {
    const context = buildBoundedAgentRunExecutionContext(
      {
        id: 'run-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        attemptNumber: 1,
        scopeSnapshot: { source: 'x'.repeat(2_000) },
        questions: [],
        messages: [],
      },
      400,
    )
    expect(context.length).toBeLessThanOrEqual(400)
    expect(context).toContain('[context truncated at 400 chars]')
  })
})
