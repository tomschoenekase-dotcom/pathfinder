import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  proposalFind: vi.fn(),
  insightFind: vi.fn(),
  targetFind: vi.fn(),
  proposalCreate: vi.fn(),
  transaction: vi.fn(),
  audit: vi.fn(),
  publish: vi.fn(),
}))

const transactionClient = {
  knowledgeChangeProposal: {
    findFirst: mocks.proposalFind,
    create: mocks.proposalCreate,
    updateMany: vi.fn(),
  },
  conversationInsight: { findFirst: mocks.insightFind },
  venueKnowledgeEntry: { findFirst: mocks.targetFind },
}

vi.mock('@pathfinder/db', () => ({
  db: {
    knowledgeChangeProposal: { findMany: vi.fn() },
    $transaction: (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      mocks.transaction(callback, transactionClient),
  },
  withTenantIsolationBypass: (callback: () => unknown) => callback(),
  writeAuditLogStrict: mocks.audit,
  publishOperationalEvent: mocks.publish,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminKnowledgeProposalsRouter } from './knowledge-proposals'

const app = router({ admin: adminKnowledgeProposalsRouter })
const operationId = '11111111-1111-4111-8111-111111111111'
const input = {
  operationId,
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  conversationInsightId: '22222222-2222-4222-8222-222222222222',
  proposedChange: 'Add verified closing hours.',
  reason: 'A visitor answer lacked verified hours.',
  confidence: 0.8,
  evidenceMessageIds: ['message-user', 'message-assistant'],
  submitForReview: true,
}

function context(): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'admin-1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin: true,
    },
  }
}

describe('admin knowledge proposals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(
      async (callback: (client: typeof transactionClient) => Promise<unknown>, client) =>
        callback(client),
    )
    mocks.insightFind.mockResolvedValue({
      id: input.conversationInsightId,
      sessionId: 'session-1',
    })
    mocks.targetFind.mockResolvedValue(null)
    mocks.proposalCreate.mockResolvedValue({ id: operationId, status: 'PENDING_REVIEW' })
    mocks.audit.mockResolvedValue(undefined)
    mocks.publish.mockResolvedValue(undefined)
  })

  it('returns only an exact idempotent replay', async () => {
    mocks.proposalFind.mockResolvedValue({
      id: operationId,
      status: 'PENDING_REVIEW',
      conversationInsightId: input.conversationInsightId,
      targetKnowledgeEntryId: null,
      observedVisitorClaim: null,
      aiInference: null,
      proposedChange: input.proposedChange,
      reason: input.reason,
      confidence: input.confidence,
      evidenceMessageIds: input.evidenceMessageIds,
    })

    await expect(app.createCaller(context()).admin.createKnowledgeProposal(input)).resolves.toEqual(
      {
        id: operationId,
        status: 'PENDING_REVIEW',
        replayed: true,
      },
    )

    await expect(
      app
        .createCaller(context())
        .admin.createKnowledgeProposal({ ...input, reason: 'Different operation' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.proposalCreate).not.toHaveBeenCalled()
  })

  it('rejects a second active proposal for the same insight', async () => {
    mocks.proposalFind
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: '33333333-3333-4333-8333-333333333333' })

    await expect(
      app.createCaller(context()).admin.createKnowledgeProposal(input),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.proposalCreate).not.toHaveBeenCalled()
  })

  it('maps a concurrent active-proposal uniqueness race to a stable conflict', async () => {
    mocks.transaction.mockRejectedValue({ code: 'P2002' })

    await expect(
      app.createCaller(context()).admin.createKnowledgeProposal(input),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
