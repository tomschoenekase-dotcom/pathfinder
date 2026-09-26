import { describe, expect, it, vi } from 'vitest'

import {
  recordConversationLearningCandidate,
  reviewConversationLearningCandidate,
  updateConversationLearningPolicy,
} from './conversation-learning-actions'

const scope = { tenantId: 'tenant-a', venueId: 'venue-a' }
const owner = { type: 'HUMAN' as const, id: 'owner-a', role: 'OWNER' as const }
const client = (tx: Record<string, unknown>) =>
  ({ $transaction: vi.fn((fn) => fn({ ...tx, $executeRaw: vi.fn() })) }) as never

describe('conversation learning actions', () => {
  it('pins the preceding answer and visitor correction within one venue conversation', async () => {
    const findTurn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'turn-correction', turnSequence: 4 })
      .mockResolvedValueOnce({ assistantMessageId: 'answer-before-correction' })
    const createMany = vi.fn().mockResolvedValue({ count: 1 })
    const tx = {
      venue: {
        findFirst: vi.fn().mockResolvedValue({
          conversationLearningPolicy: 'VISITOR_AND_EMPLOYEE',
        }),
      },
      guestChatTurn: { findFirst: findTurn },
      conversationInsight: {
        createMany,
        findFirst: vi.fn().mockResolvedValue({
          id: 'insight-a',
          candidateRevision: 0,
          reviewStatus: 'UNREVIEWED',
          candidateProvenance: {},
        }),
      },
    }
    await expect(
      recordConversationLearningCandidate(
        {
          ...scope,
          sessionId: 'session-a',
          guestChatTurnId: '11111111-1111-4111-8111-111111111111',
          userMessageId: 'visitor-correction',
          source: 'PUBLIC',
          summary: 'A conversation message may correct an existing venue fact.',
          classifier: { kind: 'FACTUAL_CORRECTION', version: 'v1' },
          hedged: false,
        },
        client(tx),
      ),
    ).resolves.toMatchObject({ replayed: false })
    expect(findTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          ...scope,
          sessionId: 'session-a',
          turnSequence: { lt: 4 },
          status: 'COMPLETE',
        }),
        orderBy: { turnSequence: 'desc' },
      }),
    )
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            ...scope,
            sessionId: 'session-a',
            evidenceMessageIds: ['answer-before-correction', 'visitor-correction'],
            candidateProvenance: expect.objectContaining({ verification: 'UNVERIFIED' }),
          }),
        ],
      }),
    )
  })

  it('rejects disabled policy before reading or writing visitor evidence', async () => {
    const tx = {
      venue: { findFirst: vi.fn().mockResolvedValue({ conversationLearningPolicy: 'DISABLED' }) },
    }
    await expect(
      recordConversationLearningCandidate(
        {
          ...scope,
          sessionId: 'session-a',
          guestChatTurnId: '11111111-1111-4111-8111-111111111111',
          userMessageId: 'message-a',
          source: 'PUBLIC',
          summary: 'Candidate.',
          classifier: { kind: 'FACTUAL_ADDITION', version: 'v1' },
          hedged: true,
        },
        client(tx),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('requires feedback for accept and reject decisions before opening a transaction', async () => {
    await expect(
      reviewConversationLearningCandidate(
        {
          operationId: '11111111-1111-4111-8111-111111111111',
          ...scope,
          insightId: '22222222-2222-4222-8222-222222222222',
          expectedRevision: 0,
          action: 'REJECT',
          actor: owner,
        },
        client({}),
      ),
    ).rejects.toThrow('review decision needs feedback')
  })

  it('rejects a stale policy compare-and-swap after durable membership validation', async () => {
    const tx = {
      tenantMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-a' }) },
      auditLog: { findFirst: vi.fn().mockResolvedValue(null) },
      venue: {
        findFirst: vi.fn().mockResolvedValue({
          conversationLearningPolicy: 'VISITOR_AND_EMPLOYEE',
          updatedAt: new Date('2026-09-08T00:00:01.000Z'),
        }),
      },
    }
    await expect(
      updateConversationLearningPolicy(
        {
          ...scope,
          policy: 'DISABLED',
          expectedUpdatedAt: new Date('2026-09-08T00:00:00.000Z'),
          operationId: '11111111-1111-4111-8111-111111111111',
          actor: owner,
        },
        client(tx),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.tenantMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE', role: 'OWNER' }),
      }),
    )
  })
})
