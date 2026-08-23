import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  KnowledgeCorrectionActionError,
  listConversationKnowledgeGaps,
  proposeKnowledgeCorrectionAction,
} from './knowledge-correction-actions'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const INSIGHT_ID = '22222222-2222-4222-8222-222222222222'

const actor = {
  type: 'AGENT' as const,
  actorId: 'agent_identity_1',
  role: 'AGENT' as const,
  agentIdentityId: 'agent_identity_1',
  agentRunId: 'agent_run_1',
  workerId: 'worker_1',
  credentialId: 'credential_1',
  capability: 'knowledge:draft',
  idempotencyKey: OPERATION_ID,
  modelProvider: 'provider-dark',
  modelName: 'deterministic-fixture',
}

const input = {
  operationId: OPERATION_ID,
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  conversationInsightId: INSIGHT_ID,
  correctionKind: 'RETRIEVAL_CORRECTION' as const,
  aiInference: 'The current answer lacks a trusted supporting source.',
  proposedChange: 'Add a current, source-backed accessibility entry to the retrieval corpus.',
  reason: 'The guest asked a reasonable public question and the answer had no strong match.',
  confidence: 0.82,
  actor,
}

function transactionClient() {
  const tx = {
    knowledgeChangeProposal: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: OPERATION_ID,
        status: 'PENDING_REVIEW',
        createdAt: new Date('2026-08-22T20:00:00.000Z'),
        updatedAt: new Date('2026-08-22T20:00:00.000Z'),
      }),
    },
    conversationInsight: {
      findFirst: vi.fn().mockResolvedValue({
        id: INSIGHT_ID,
        sessionId: 'session_1',
        category: 'KNOWLEDGE_GAP',
        guestChatTurn: {
          userMessage: { id: 'message_user', content: 'Where is the accessible entrance?' },
          assistantMessage: { id: 'message_assistant', content: 'I do not have that information.' },
        },
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    venueKnowledgeEntry: { findFirst: vi.fn().mockResolvedValue({ id: 'knowledge_1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  return {
    tx,
    client: {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    },
  }
}

describe('knowledge correction actions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns bounded public question and assistant evidence for reviewable gaps', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: INSIGHT_ID,
        category: 'LOW_CONFIDENCE_ANSWER',
        confidence: 0.7,
        severity: 'MEDIUM',
        summary: 'Weak retrieval evidence.',
        suggestedAction: 'Review the answer.',
        createdAt: new Date('2026-08-22T19:00:00.000Z'),
        guestChatTurn: {
          id: 'turn_1',
          userMessage: { id: 'message_user', content: 'Where is the accessible entrance?' },
          assistantMessage: { id: 'message_assistant', content: 'I do not have that information.' },
        },
      },
    ])

    await expect(
      listConversationKnowledgeGaps({ tenantId: 'tenant_1', venueId: 'venue_1', limit: 5 }, {
        conversationInsight: { findMany },
      } as never),
    ).resolves.toEqual([
      expect.objectContaining({
        id: INSIGHT_ID,
        visitorQuestion: 'Where is the accessible entrance?',
        assistantAnswer: 'I do not have that information.',
        evidenceMessageIds: ['message_user', 'message_assistant'],
      }),
    ])
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          session: { experienceScope: 'PUBLIC' },
        }),
        take: 5,
      }),
    )
    expect(findMany.mock.calls[0]?.[0]?.where).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({
            category: 'VISITOR_NEGATIVE_FEEDBACK',
            guestChatTurn: {
              assistantMessage: { feedback: { some: { rating: 'NOT_HELPFUL' } } },
            },
          }),
        ]),
      }),
    )
  })

  it('creates one review-only agent proposal from server-derived message evidence', async () => {
    const { client, tx } = transactionClient()
    await expect(proposeKnowledgeCorrectionAction(input, client as never)).resolves.toEqual({
      proposal: expect.objectContaining({ id: OPERATION_ID, status: 'PENDING_REVIEW' }),
      replayed: false,
    })

    expect(tx.knowledgeChangeProposal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: OPERATION_ID,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        sessionId: 'session_1',
        conversationInsightId: INSIGHT_ID,
        observedVisitorClaim: 'Visitor asked: Where is the accessible entrance?',
        proposedChange:
          '[RETRIEVAL_CORRECTION]\nAdd a current, source-backed accessibility entry to the retrieval corpus.',
        evidenceMessageIds: ['message_user', 'message_assistant'],
        status: 'PENDING_REVIEW',
        createdByType: 'AGENT',
        createdById: 'agent_identity_1',
      }),
      select: expect.any(Object),
    })
    expect(tx.conversationInsight.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reviewStatus: 'ACTIONED' }) }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: 'AGENT',
        action: 'knowledge-proposal.agent-prepared',
        agentRunId: 'agent_run_1',
        credentialId: 'credential_1',
        capability: 'knowledge:draft',
      }),
    })
  })

  it('fails closed when the insight lacks exact public turn evidence', async () => {
    const { client, tx } = transactionClient()
    tx.conversationInsight.findFirst.mockResolvedValue(null)
    await expect(proposeKnowledgeCorrectionAction(input, client as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<KnowledgeCorrectionActionError>)
    expect(tx.knowledgeChangeProposal.create).not.toHaveBeenCalled()
  })

  it('returns an exact idempotent replay and rejects operation-ID drift', async () => {
    const { client, tx } = transactionClient()
    tx.knowledgeChangeProposal.findUnique.mockResolvedValue({
      id: OPERATION_ID,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      conversationInsightId: INSIGHT_ID,
      targetKnowledgeEntryId: null,
      aiInference: input.aiInference,
      proposedChange: `[RETRIEVAL_CORRECTION]\n${input.proposedChange}`,
      reason: input.reason,
      confidence: input.confidence,
      createdByType: 'AGENT',
      createdById: 'agent_identity_1',
      status: 'PENDING_REVIEW',
    })

    await expect(proposeKnowledgeCorrectionAction(input, client as never)).resolves.toMatchObject({
      replayed: true,
    })
    await expect(
      proposeKnowledgeCorrectionAction(
        { ...input, proposedChange: 'Different correction.' },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects actors without the exact knowledge-draft capability before database access', async () => {
    const { client } = transactionClient()
    await expect(
      proposeKnowledgeCorrectionAction(
        { ...input, actor: { ...actor, capability: 'knowledge:read' } },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })
})
