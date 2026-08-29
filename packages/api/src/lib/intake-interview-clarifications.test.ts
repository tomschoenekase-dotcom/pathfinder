import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  askQuestion: vi.fn(),
  getReview: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  AgentQuestionActionError: class AgentQuestionActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  IntakeActionError: class IntakeActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  askAgentQuestionAction: mocks.askQuestion,
  getIntakeProposalReview: mocks.getReview,
}))

import {
  buildInterviewClarificationReview,
  createInterviewClarificationQuestions,
  resolveInterviewClarification,
} from './intake-interview-clarifications'

function review() {
  return {
    id: 'run-a',
    sourceKind: 'INTERVIEW',
    status: 'AWAITING_REVIEW',
    role: 'OPERATIONS',
    consentVerified: true,
    answers: [
      {
        questionId: 'operations.hours',
        prompt: 'What are the public hours?',
        fieldPath: 'venue.operations.hours',
        privacy: 'PUBLIC_CANDIDATE',
        skipped: false,
        redacted: false,
        confidence: 0.55,
        evidenceId: 'evidence-hours',
        publicText: 'Open nine to five.',
        discrepancies: ['LOW_CONFIDENCE'],
      },
      {
        questionId: 'operations.closures',
        prompt: 'When is the venue closed?',
        fieldPath: 'venue.operations.closures',
        privacy: 'PUBLIC_CANDIDATE',
        skipped: false,
        redacted: true,
        confidence: 0.8,
        evidenceId: null,
        publicText: null,
        discrepancies: ['MISSING_CONTEXT'],
      },
      {
        questionId: 'operations.internal-procedures',
        prompt: 'What are the internal procedures?',
        fieldPath: 'venue.operations.internalProcedures',
        privacy: 'PRIVATE',
        skipped: false,
        redacted: false,
        confidence: 0.9,
        evidenceId: 'evidence-private',
        publicText: null,
        discrepancies: [],
      },
    ],
  } as never
}

describe('staff interview clarification projection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('binds deterministic questions to exact scoped public evidence without exposing private text', () => {
    const input = {
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      review: review(),
    }
    const first = buildInterviewClarificationReview(input)
    const replay = buildInterviewClarificationReview(input)
    const otherVenue = buildInterviewClarificationReview({ ...input, venueId: 'venue-b' })

    expect(replay).toEqual(first)
    expect(first.reviewHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.clarifications).toHaveLength(2)
    expect(first.clarifications[0]).toMatchObject({
      fieldPath: 'venue.operations.closures',
      reasons: ['MISSING_CONTEXT'],
    })
    expect(first.clarifications[0]).not.toHaveProperty('proposedAnswer')
    expect(first.clarifications[1]).toMatchObject({
      fieldPath: 'venue.operations.hours',
      reasons: ['LOW_CONFIDENCE'],
      evidence: [{ kind: 'DOCUMENT_EXCERPT' }],
      proposedAnswer: { value: 'Open nine to five.', status: 'PROPOSED_ONLY' },
    })
    expect(otherVenue.clarifications[0]?.operationId).not.toBe(first.clarifications[0]?.operationId)
    expect(JSON.stringify(first)).not.toContain('internal-procedures')
    expect(JSON.stringify(first)).not.toContain('evidence-private')
  })

  it('creates scoped replay-safe guidance only and rejects stale evidence before mutation', async () => {
    const exactReview = review()
    mocks.getReview.mockResolvedValue(exactReview)
    mocks.askQuestion.mockImplementation(async (input) => ({
      question: { id: `question-${input.callbackMetadata.clarificationId}`, status: 'PENDING' },
      replayed: false,
    }))
    const projected = buildInterviewClarificationReview({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      review: exactReview,
    })
    const db = {
      agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'identity-a' }) },
    } as never

    await expect(
      createInterviewClarificationQuestions({
        db,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        expectedReviewHash: 'b'.repeat(64),
        clarificationIds: [projected.clarifications[0]!.clarificationId],
        agentIdentityId: 'identity-a',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.askQuestion).not.toHaveBeenCalled()

    const result = await createInterviewClarificationQuestions({
      db,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      expectedReviewHash: projected.reviewHash,
      clarificationIds: projected.clarifications.map(({ clarificationId }) => clarificationId),
      agentIdentityId: 'identity-a',
    })

    expect(result).toMatchObject({
      sourceAmendmentRequired: true,
      executionTriggered: false,
      approvalGranted: false,
      canonicalVenueChanged: false,
      packageDraftCreated: false,
      publicationTriggered: false,
      venueContactTriggered: false,
    })
    expect(mocks.askQuestion).toHaveBeenCalledTimes(2)
    expect(mocks.askQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        agentIdentityId: 'identity-a',
        category: 'builder-interview-clarification',
        blocking: true,
        evidence: [expect.objectContaining({ kind: 'DOCUMENT_EXCERPT' })],
        callbackMetadata: expect.objectContaining({
          workflow: 'intake-interview-clarification',
          runId: 'run-a',
          reviewHash: projected.reviewHash,
        }),
      }),
      db,
    )
  })

  it('records an exact answered-question source amendment without creating a package or authority', async () => {
    const exactReview = review()
    mocks.getReview.mockResolvedValue(exactReview)
    const projected = buildInterviewClarificationReview({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      review: exactReview,
    })
    const clarification = projected.clarifications.find(
      ({ fieldPath }) => fieldPath === 'venue.operations.hours',
    )!
    const answeredAt = new Date('2026-08-29T22:00:00.000Z')
    const create = vi.fn().mockImplementation(async ({ data }) => ({
      ...data,
      createdAt: new Date('2026-08-29T22:01:00.000Z'),
    }))
    const transaction = {
      $executeRaw: vi.fn(),
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'question-a',
          answer: 'Use nine to five, except event nights.',
          answeredAt,
        }),
      },
      intakeInterviewClarificationResolution: {
        findUnique: vi.fn().mockResolvedValue(null),
        create,
      },
    }
    const db = {
      $transaction: vi.fn().mockImplementation(async (callback) => callback(transaction)),
    } as never

    const result = await resolveInterviewClarification({
      db,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      requestId: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
      expectedReviewHash: projected.reviewHash,
      clarificationId: clarification.clarificationId,
      expectedAnsweredAt: answeredAt,
      kind: 'REPLACE_PUBLIC_TEXT',
      amendedPublicText: 'Open nine to five, except event nights.',
      rationale: 'Founder clarified the public exception wording.',
      actorId: 'founder-a',
    })

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        questionId: 'question-a',
        reviewHash: projected.reviewHash,
        clarificationId: clarification.clarificationId,
        fieldPath: 'venue.operations.hours',
        kind: 'REPLACE_PUBLIC_TEXT',
        amendedPublicText: 'Open nine to five, except event nights.',
        answerHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        amendedTextHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        createdBy: 'founder-a',
      }),
    })
    expect(result).toMatchObject({
      questionId: 'question-a',
      candidateRecomputationRequired: true,
      packageDraftCreated: false,
      approvalGranted: false,
      canonicalVenueChanged: false,
      publicationTriggered: false,
      venueContactTriggered: false,
    })
  })

  it('fails closed when the answered question timestamp does not match', async () => {
    const exactReview = review()
    mocks.getReview.mockResolvedValue(exactReview)
    const projected = buildInterviewClarificationReview({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      review: exactReview,
    })
    const clarification = projected.clarifications[0]!
    const create = vi.fn()
    const transaction = {
      $executeRaw: vi.fn(),
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'question-a',
          answer: 'Use the clarified value.',
          answeredAt: new Date('2026-08-29T22:00:00.000Z'),
        }),
      },
      intakeInterviewClarificationResolution: { findUnique: vi.fn(), create },
    }
    const db = {
      $transaction: vi.fn().mockImplementation(async (callback) => callback(transaction)),
    } as never

    await expect(
      resolveInterviewClarification({
        db,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        requestId: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
        expectedReviewHash: projected.reviewHash,
        clarificationId: clarification.clarificationId,
        expectedAnsweredAt: new Date('2026-08-29T22:00:01.000Z'),
        kind: 'EXCLUDE_FIELD',
        rationale: 'Exclude this unresolved field from the draft.',
        actorId: 'founder-a',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(create).not.toHaveBeenCalled()
  })
})
