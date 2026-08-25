import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  proposalFind: vi.fn(),
  insightFind: vi.fn(),
  targetFind: vi.fn(),
  proposalCreate: vi.fn(),
  transaction: vi.fn(),
  audit: vi.fn(),
  publish: vi.fn(),
  prepareSupport: vi.fn(),
  semanticPreview: vi.fn(),
  semanticFinalizer: vi.fn(),
  createVenuePackageDraft: vi.fn(),
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
  prepareSupportKnowledgeProposalAction: mocks.prepareSupport,
  SupportKnowledgeProposalActionError: class SupportKnowledgeProposalActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
}))
vi.mock('../../lib/semantic-venue-updater-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/semantic-venue-updater-service')>()
  return { ...actual, previewSemanticVenueUpdateFromProposal: mocks.semanticPreview }
})
vi.mock('../../lib/semantic-venue-update-finalizer', () => ({
  semanticVenueUpdateDraftFinalizer: mocks.semanticFinalizer,
}))
vi.mock('../venue-package', () => ({
  createVenuePackageDraftService: mocks.createVenuePackageDraft,
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
    mocks.prepareSupport.mockResolvedValue({
      proposal: {
        id: operationId,
        status: 'PENDING_REVIEW',
        supportRequestId: 'support-request-1',
        supportRequestVersion: 3,
      },
      replayed: false,
    })
    mocks.semanticFinalizer.mockReturnValue(vi.fn())
    mocks.semanticPreview.mockResolvedValue({
      proposalStatus: 'APPROVED',
      previewHash: 'a'.repeat(64),
      classification: 'CORRECTION',
      venuePackagePatch: {
        schemaVersion: 3,
        places: { create: [], update: [], delete: [] },
        knowledgeEntries: {
          create: [],
          update: [
            {
              itemKey: '33333333-3333-4333-8333-333333333333',
              id: 'cm12345678901234567890123',
              provenance: {
                sourceType: 'KNOWLEDGE_PROPOSAL',
                contentOrigin: 'HUMAN_AUTHORED',
              },
              value: {
                title: 'Museum hours',
                category: 'HOURS',
                content: 'Open 9–5 daily.',
                isEnabled: true,
              },
            },
          ],
          delete: [],
        },
      },
    })
    mocks.createVenuePackageDraft.mockResolvedValue({
      value: { id: 'package-a', status: 'DRAFT', replayed: false },
    })
  })

  it('returns only an exact idempotent replay', async () => {
    mocks.proposalFind.mockResolvedValue({
      id: operationId,
      status: 'PENDING_REVIEW',
      conversationInsightId: input.conversationInsightId,
      supportRequestId: null,
      supportRequestVersion: null,
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

  it('prepares a support-linked proposal without canonical knowledge or customer effects', async () => {
    await expect(
      app.createCaller(context()).admin.createSupportKnowledgeProposal({
        operationId,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        supportRequestId: 'support-request-1',
        expectedVersion: 3,
        evidenceMessageIds: ['support-message-1'],
        correctionKind: 'UPDATE_KNOWLEDGE',
        proposedChange: 'Use the verified east entrance.',
        reason: 'The client supplied corrected entrance details.',
        confidence: 0.9,
      }),
    ).resolves.toMatchObject({
      id: operationId,
      status: 'PENDING_REVIEW',
      canonicalKnowledgeChanged: false,
      replayed: false,
    })

    expect(mocks.prepareSupport).toHaveBeenCalledWith(
      expect.objectContaining({
        supportRequestId: 'support-request-1',
        expectedVersion: 3,
        actor: {
          type: 'HUMAN',
          actorId: 'admin-1',
          role: 'PLATFORM_ADMIN',
        },
      }),
      expect.anything(),
    )
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          sourceSubsystem: 'support-operations',
          linkedObjectId: operationId,
        }),
      }),
    )
  })

  it('creates only the exact approved semantic package DRAFT and preserves later approval gates', async () => {
    const desired = {
      title: 'Museum hours',
      category: 'HOURS',
      content: 'Open 9–5 daily.',
      isEnabled: true,
    }
    await expect(
      app.createCaller(context()).admin.createSemanticVenueUpdatePackageDraft({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        proposalId: operationId,
        expectedUpdatedAt: new Date('2026-08-25T13:00:00.000Z'),
        expectedPreviewHash: 'a'.repeat(64),
        relation: 'CORRECTS',
        desired,
      }),
    ).resolves.toEqual({
      packageId: 'package-a',
      packageStatus: 'DRAFT',
      replayed: false,
      previewHash: 'a'.repeat(64),
      classification: 'CORRECTION',
      autoApproved: false,
      autoApplied: false,
      autoPublished: false,
    })

    expect(mocks.createVenuePackageDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
        input: expect.objectContaining({
          venueId: 'venue-1',
          draftKey: expect.stringMatching(/^[a-f0-9-]{36}$/u),
        }),
        finalizer: expect.any(Function),
      }),
    )
  })

  it('rejects preview drift before package creation', async () => {
    await expect(
      app.createCaller(context()).admin.createSemanticVenueUpdatePackageDraft({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        proposalId: operationId,
        expectedUpdatedAt: new Date('2026-08-25T13:00:00.000Z'),
        expectedPreviewHash: 'b'.repeat(64),
        relation: 'CORRECTS',
        desired: {
          title: 'Museum hours',
          category: 'HOURS',
          content: 'Open 9–5 daily.',
          isEnabled: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.createVenuePackageDraft).not.toHaveBeenCalled()
  })
})
