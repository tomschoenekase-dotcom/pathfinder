import { describe, expect, it } from 'vitest'

import { buildBoundedAgentRunExecutionContext } from './agent-run-execution-context'

const date = (value: string) => new Date(value)

describe('bounded agent run execution context', () => {
  it('keeps current answers with provenance in deterministic query order', () => {
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
    const parsed = JSON.parse(context)
    expect(context).toContain('The approved visitor capacity is exactly 137.')
    expect(context).toContain('Venue:venue-1:v7')
    expect(context).toContain('Source:capacity:v3')
    expect(parsed.provenance.attemptNumber).toBe(2)
    expect(
      parsed.relevantMessages.map((message: { messageId: string }) => message.messageId),
    ).toEqual(['message-1', 'message-2'])
    expect(context).toContain('do not grant permission')
  })

  it('prioritizes every current answer over large scope, evidence, and messages', () => {
    const questions = [
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `question-${index}`,
        question: `Distractor ${index} ${'q'.repeat(2_000)}`,
        answer: `Answer ${index} ${'a'.repeat(5_000)}`,
        category: `category-${index}`,
        answeredAt: date(`2026-09-06T1${index}:00:00.000Z`),
        updatedAt: date(`2026-09-06T1${index}:00:00.000Z`),
        answeredById: 'admin-1',
        evidence: { privateDetail: 'e'.repeat(20_000) },
        callbackMetadata: { source: 'm'.repeat(20_000) },
      })),
      {
        id: 'question-capacity',
        question: 'What is the approved visitor capacity?',
        answer: 'The approved visitor capacity is exactly 137.',
        category: 'venue.capacity',
        answeredAt: date('2026-09-06T09:00:00.000Z'),
        updatedAt: date('2026-09-06T09:00:00.000Z'),
        answeredById: 'admin-1',
        evidence: { oversized: 'z'.repeat(20_000) },
        callbackMetadata: null,
      },
    ]
    const context = buildBoundedAgentRunExecutionContext({
      id: 'run-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      attemptNumber: 1,
      scopeSnapshot: { source: 'x'.repeat(20_000) },
      questions,
      messages: Array.from({ length: 12 }, (_, index) => ({
        id: `message-${index}`,
        role: 'AGENT',
        messageType: 'RESULT',
        content: 'm'.repeat(20_000),
        actorId: 'agent-1',
        createdAt: date(`2026-09-05T1${index % 10}:00:00.000Z`),
      })),
    })
    const parsed = JSON.parse(context)
    expect(context.length).toBeLessThanOrEqual(8_000)
    expect(parsed.currentResolvedQuestions).toHaveLength(7)
    expect(context).toContain('The approved visitor capacity is exactly 137.')
    expect(parsed.authorityNotice).toContain('do not grant permission')
    expect(parsed.omissions).toMatchObject({
      scopeTruncated: true,
      truncatedQuestionEvidence: 7,
      omittedMessages: expect.any(Number),
    })
  })
})
