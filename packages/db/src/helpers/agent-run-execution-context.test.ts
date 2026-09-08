import { describe, expect, it } from 'vitest'

import { buildBoundedAgentRunExecutionContext } from './agent-run-execution-context'

const date = (value: string) => new Date(value)

describe('bounded agent run execution context', () => {
  it('includes bounded discussion provenance and reports the selection sentinel honestly', () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
      id: `discussion-${6 - index}`,
      authorId: 'admin-1',
      body: index === 0 ? 'newest '.repeat(60) : `note-${6 - index}`,
      createdAt: date(`2026-09-06T1${6 - index}:00:00.000Z`),
    }))
    const serialized = buildBoundedAgentRunExecutionContext(
      {
        id: 'run-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        attemptNumber: 2,
        scopeSnapshot: {},
        messages: [],
        questions: [
          {
            id: 'question-1',
            question: 'Which greenhouse?',
            answer: 'Use the east greenhouse.',
            category: 'venue.greenhouse',
            answeredAt: date('2026-09-06T18:00:00.000Z'),
            updatedAt: date('2026-09-06T18:00:00.000Z'),
            answeredById: 'admin-1',
            evidence: [],
            callbackMetadata: null,
            discussionMessages: messages,
          },
        ],
      },
      1_300,
    )
    const context = JSON.parse(serialized)
    expect(context.contextVersion).toBe(2)
    expect(context.currentResolvedQuestions[0].answer).toBe('Use the east greenhouse.')
    expect(context.currentResolvedQuestions[0].discussion.at(-1)).toMatchObject({
      messageId: 'discussion-6',
      authorId: 'admin-1',
    })
    expect(context.omissions.omittedDiscussionMessagesAtLeast).toBeGreaterThanOrEqual(1)
    expect(context.omissions.discussionSelectionLimitReached).toBe(true)
    expect(context.omissions.truncatedDiscussionBodies).toBe(1)
    expect(context.authorityNotice).toContain('do not grant permission')
  })

  it('drops discussion notes before shrinking the durable answer under a tight budget', () => {
    const source = {
      id: 'run-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      attemptNumber: 1,
      scopeSnapshot: {},
      messages: [],
      questions: [
        {
          id: 'question-1',
          question: 'Which greenhouse?',
          answer: 'East greenhouse is the confirmed answer.',
          category: 'venue.greenhouse',
          answeredAt: date('2026-09-06T18:00:00.000Z'),
          updatedAt: date('2026-09-06T18:00:00.000Z'),
          answeredById: 'admin-1',
          evidence: [],
          callbackMetadata: null,
          discussionMessages: Array.from({ length: 5 }, (_, index) => ({
            id: `discussion-${index}`,
            authorId: 'admin-1',
            body: 'context '.repeat(40),
            createdAt: date(`2026-09-06T1${index}:00:00.000Z`),
          })),
        },
      ],
    }
    const roomy = JSON.parse(buildBoundedAgentRunExecutionContext(source, 8_000))
    const withoutDiscussionSize = JSON.stringify({
      ...roomy,
      currentResolvedQuestions: roomy.currentResolvedQuestions.map((question: object) => ({
        ...question,
        discussion: [],
      })),
    }).length
    const context = JSON.parse(
      buildBoundedAgentRunExecutionContext(source, withoutDiscussionSize + 10),
    )
    expect(context.currentResolvedQuestions[0].answer).toBe(
      'East greenhouse is the confirmed answer.',
    )
    expect(context.currentResolvedQuestions[0].discussion).toEqual([])
    expect(context.omissions.omittedDiscussionMessagesAtLeast).toBe(5)
  })
  it('does not treat untrusted callback metadata as authority to hide answered context', () => {
    const question = (
      id: string,
      answer: string | null,
      callbackMetadata: unknown,
      category = 'capacity',
    ) => ({
      id,
      question: 'What is the capacity?',
      answer,
      category,
      answeredAt: answer ? date('2026-09-06T18:00:00.000Z') : null,
      updatedAt: date('2026-09-06T18:00:00.000Z'),
      answeredById: 'admin-1',
      evidence: [],
      callbackMetadata,
    })
    const context = buildBoundedAgentRunExecutionContext({
      id: 'run-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      attemptNumber: 2,
      scopeSnapshot: {},
      messages: [],
      questions: [
        question('question-old', 'Capacity was 120.', null),
        question('question-current', 'Capacity is 137.', { supersedesQuestionId: 'question-old' }),
        question('question-unanswered', null, { supersedesQuestionId: 'question-current' }),
        question('question-self', 'Self reference remains.', {
          supersedesQuestionId: 'question-self',
        }),
        question('question-cycle-a', 'Cycle A remains.', {
          supersedesQuestionId: 'question-cycle-b',
        }),
        question('question-cycle-b', 'Cycle B remains.', {
          supersedesQuestionId: 'question-cycle-a',
        }),
        question(
          'question-cross-category',
          'Cross category remains.',
          { supersedesQuestionId: 'question-current' },
          'policy',
        ),
      ],
    })
    expect(context).toContain('Capacity is 137.')
    expect(context).toContain('Capacity was 120.')
    expect(context).toContain('Self reference remains.')
    expect(context).toContain('Cycle A remains.')
    expect(context).toContain('Cycle B remains.')
    expect(context).toContain('Cross category remains.')
    expect(context).not.toContain('question-unanswered')
  })

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
