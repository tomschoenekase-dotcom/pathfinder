import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  listGaps: vi.fn(),
  insightFind: vi.fn(),
  insightUpdate: vi.fn(),
  venueFind: vi.fn(),
  placeFindMany: vi.fn(),
  caseFind: vi.fn(),
  createCase: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: mocks.bypass,
  listConversationKnowledgeGaps: mocks.listGaps,
  hashEvalCase: () => 'f'.repeat(64),
  createOrReplayEvaluationCase: mocks.createCase,
  writeAuditLogStrict: mocks.audit,
  db: {
    $transaction: vi.fn(async (operation) =>
      operation({
        conversationInsight: {
          findFirst: mocks.insightFind,
          updateMany: mocks.insightUpdate,
        },
        venue: { findFirst: mocks.venueFind },
        place: { findMany: mocks.placeFindMany },
        evalCase: { findFirst: mocks.caseFind },
        auditLog: { create: vi.fn() },
      }),
    ),
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminEvaluationConversationCasesRouter } from './evaluation-conversation-cases'

const testRouter = router({ evaluations: adminEvaluationConversationCasesRouter })

function context(): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator_1',
      activeTenantId: 'tenant_other',
      role: 'STAFF',
      isPlatformAdmin: true,
    },
  }
}

const insightId = '11111111-1111-4111-8111-111111111111'
const turnId = '22222222-2222-4222-8222-222222222222'

function insight(overrides: Record<string, unknown> = {}) {
  return {
    id: insightId,
    category: 'VISITOR_NEGATIVE_FEEDBACK',
    reviewStatus: 'UNREVIEWED',
    guestChatTurnId: turnId,
    guestChatTurn: {
      id: turnId,
      userMessage: { id: 'message_user' },
      assistantMessage: {
        id: 'message_assistant',
        feedback: [{ rating: 'NOT_HELPFUL' }],
      },
    },
    ...overrides,
  }
}

describe('conversation-derived evaluation cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.insightFind.mockResolvedValue(insight())
    mocks.insightUpdate.mockResolvedValue({ count: 1 })
    mocks.venueFind.mockResolvedValue({ guideMode: 'location_aware' })
    mocks.placeFindMany.mockResolvedValue([{ name: 'Main Hall' }, { name: 'Main Hall' }])
    mocks.caseFind.mockResolvedValue(null)
    mocks.createCase.mockImplementation(async ({ caseId, identity }) => ({
      evalCase: {
        id: caseId,
        caseKey: identity.caseKey,
        revision: identity.revision,
        category: identity.category,
      },
      replayed: false,
    }))
    mocks.audit.mockResolvedValue(undefined)
  })

  it('lists only the existing bounded review queue through tenant bypass', async () => {
    mocks.listGaps.mockResolvedValue([{ id: insightId, visitorQuestion: 'Raw question' }])
    await expect(
      testRouter.createCaller(context()).evaluations.listEvaluationSourceInsights({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      }),
    ).resolves.toEqual([{ id: insightId, visitorQuestion: 'Raw question' }])
    expect(mocks.listGaps).toHaveBeenCalledWith(
      { tenantId: 'tenant_1', venueId: 'venue_1', limit: 10 },
      expect.anything(),
    )
  })

  it('creates a sanitized known-answer revision without copying the failed answer', async () => {
    const result = await testRouter
      .createCaller(context())
      .evaluations.prepareConversationEvaluationCase({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        insightId,
        sanitizedQuestion: 'Where is the accessible entrance?',
        expectation: 'KNOWN_ANSWER',
        acceptablePhrases: ['north entrance', 'ramp entrance'],
        forbiddenPhrases: ['staff-only door'],
        maxWords: 80,
        sanitizationConfirmed: true,
      })

    expect(result).toMatchObject({
      caseKey: `conversation-insight-${insightId}`,
      revision: 1,
      category: 'known-answer',
      sourceInsightId: insightId,
      replayed: false,
    })
    expect(mocks.createCase).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          sourceType: 'REVIEWED_CONVERSATION_INSIGHT',
          sourceRef: `conversation-insight:${insightId}:turn:${turnId}`,
          caseSnapshot: expect.objectContaining({
            turns: [{ role: 'user', content: 'Where is the accessible entrance?' }],
            venue: expect.objectContaining({
              placeNameUniverse: ['Main Hall'],
              allowedPlaceNames: ['Main Hall'],
            }),
            rules: expect.objectContaining({
              requiredFacts: [
                {
                  ruleId: 'human-expected-answer',
                  acceptablePhrases: ['north entrance', 'ramp entrance'],
                },
              ],
              forbiddenPhrases: [{ ruleId: 'human-forbidden-1', phrase: 'staff-only door' }],
            }),
          }),
        }),
      }),
    )
    expect(JSON.stringify(mocks.createCase.mock.calls)).not.toContain('message_assistant')
    expect(mocks.insightUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reviewStatus: 'ACKNOWLEDGED' }) }),
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'evaluation-case.prepared-from-conversation',
        afterState: expect.objectContaining({ sanitizationConfirmed: true }),
      }),
      expect.anything(),
    )
  })

  it('replays an exact unknown-answer case and preserves an acknowledged insight', async () => {
    mocks.insightFind.mockResolvedValue(
      insight({ category: 'KNOWLEDGE_GAP', reviewStatus: 'ACKNOWLEDGED' }),
    )
    mocks.caseFind.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      revision: 3,
      caseHash: 'f'.repeat(64),
      sourceType: 'REVIEWED_CONVERSATION_INSIGHT',
      sourceRef: `conversation-insight:${insightId}:turn:${turnId}`,
    })
    mocks.createCase.mockImplementation(async ({ caseId, identity }) => ({
      evalCase: {
        id: caseId,
        caseKey: identity.caseKey,
        revision: identity.revision,
        category: identity.category,
      },
      replayed: true,
    }))

    await expect(
      testRouter.createCaller(context()).evaluations.prepareConversationEvaluationCase({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        insightId,
        sanitizedQuestion: 'What is the private office phone number?',
        expectation: 'UNKNOWN_ANSWER',
        acceptablePhrases: ["I don't have that information"],
        forbiddenPhrases: [],
        maxWords: 60,
        sanitizationConfirmed: true,
      }),
    ).resolves.toMatchObject({ revision: 3, category: 'unknown-answer', replayed: true })
    expect(mocks.insightUpdate).not.toHaveBeenCalled()
    expect(mocks.createCase).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: '33333333-3333-4333-8333-333333333333',
        identity: expect.objectContaining({ revision: 3 }),
      }),
    )
  })

  it('rejects stale negative feedback and missing sanitization attestation', async () => {
    mocks.insightFind.mockResolvedValue(
      insight({
        guestChatTurn: {
          id: turnId,
          userMessage: { id: 'message_user' },
          assistantMessage: { id: 'message_assistant', feedback: [{ rating: 'HELPFUL' }] },
        },
      }),
    )
    const request = {
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      insightId,
      sanitizedQuestion: 'Where is the entrance?',
      expectation: 'KNOWN_ANSWER' as const,
      acceptablePhrases: ['north entrance'],
      forbiddenPhrases: [],
      maxWords: 60,
      sanitizationConfirmed: true as const,
    }
    await expect(
      testRouter.createCaller(context()).evaluations.prepareConversationEvaluationCase(request),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(
      testRouter.createCaller(context()).evaluations.prepareConversationEvaluationCase({
        ...request,
        sanitizationConfirmed: false,
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.createCase).not.toHaveBeenCalled()
  })
})
