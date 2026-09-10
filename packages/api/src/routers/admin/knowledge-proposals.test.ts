import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  proposalFind: vi.fn(),
  proposalList: vi.fn(),
  insightFind: vi.fn(),
  targetFind: vi.fn(),
  messageFind: vi.fn(),
  proposalCreate: vi.fn(),
  transaction: vi.fn(),
  audit: vi.fn(),
  publish: vi.fn(),
  prepareSupport: vi.fn(),
  semanticPreview: vi.fn(),
  semanticFinalizer: vi.fn(),
  createVenuePackageDraft: vi.fn(),
  createOperationalUpdate: vi.fn(),
  operationalFinalizer: vi.fn(),
  operationalHandoffFind: vi.fn(),
  createUniversalDraft: vi.fn(),
  askQuestion: vi.fn(),
  identityFind: vi.fn(),
  identitiesFind: vi.fn(),
  agentQuestionFind: vi.fn(),
}))

const transactionClient = {
  knowledgeChangeProposal: {
    findFirst: mocks.proposalFind,
    create: mocks.proposalCreate,
    updateMany: vi.fn(),
  },
  conversationInsight: { findFirst: mocks.insightFind },
  venueKnowledgeEntry: { findFirst: mocks.targetFind },
  message: { findMany: mocks.messageFind },
}

vi.mock('@pathfinder/db', () => ({
  db: {
    knowledgeChangeProposal: { findMany: mocks.proposalList },
    $transaction: (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      mocks.transaction(callback, transactionClient),
  },
  withTenantIsolationBypass: (callback: () => unknown) => callback(),
  writeAuditLogStrict: mocks.audit,
  publishOperationalEvent: mocks.publish,
  prepareSupportKnowledgeProposalAction: mocks.prepareSupport,
  createOperationalUpdateAction: mocks.createOperationalUpdate,
  askAgentQuestionAction: mocks.askQuestion,
  AgentQuestionActionError: class AgentQuestionActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
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
vi.mock('../../lib/semantic-operational-update-finalizer', () => ({
  semanticOperationalUpdateDraftFinalizer: mocks.operationalFinalizer,
}))
vi.mock('../../lib/semantic-universal-content-handoff-service', () => ({
  createSemanticUniversalContentDraftService: mocks.createUniversalDraft,
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
    db: {
      knowledgeProposalOperationalUpdateHandoff: {
        findFirst: mocks.operationalHandoffFind,
      },
      agentIdentity: { findFirst: mocks.identityFind, findMany: mocks.identitiesFind },
      agentQuestion: { findFirst: mocks.agentQuestionFind },
    } as unknown as TRPCContext['db'],
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
    mocks.proposalFind.mockResolvedValue(null)
    mocks.targetFind.mockResolvedValue(null)
    mocks.messageFind.mockResolvedValue(input.evidenceMessageIds.map((id) => ({ id })))
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
    mocks.operationalFinalizer.mockReturnValue(vi.fn())
    mocks.operationalHandoffFind.mockResolvedValue(null)
    mocks.identityFind.mockResolvedValue({ id: 'content-agent-1' })
    mocks.identitiesFind.mockResolvedValue([])
    mocks.agentQuestionFind.mockResolvedValue(null)
    mocks.askQuestion.mockResolvedValue({
      question: { id: 'question-1', status: 'PENDING' },
      replayed: false,
    })
    mocks.createOperationalUpdate.mockResolvedValue({
      update: { id: '44444444-4444-4444-8444-444444444444', status: 'DRAFT' },
      preview: { lifecycle: 'DRAFT' },
    })
    mocks.createUniversalDraft.mockResolvedValue({
      moduleId: '44444444-4444-4444-8444-444444444444',
      revisionId: 'revision-2',
      version: 2,
      classification: 'CORRECTION',
      draftHash: 'd'.repeat(64),
      replayed: false,
    })
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

  it.each([
    ['another tenant', [{ id: input.evidenceMessageIds[0] }]],
    ['another venue', [{ id: input.evidenceMessageIds[0] }]],
    ['another session', [{ id: input.evidenceMessageIds[0] }]],
    ['a nonexistent message', [{ id: input.evidenceMessageIds[0] }]],
  ])('rejects %s evidence instead of persisting unverified IDs', async (_label, evidence) => {
    mocks.messageFind.mockResolvedValueOnce(evidence)

    await expect(
      app.createCaller(context()).admin.createKnowledgeProposal(input),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(mocks.proposalCreate).not.toHaveBeenCalled()
    expect(mocks.messageFind).toHaveBeenCalledWith({
      where: {
        id: { in: input.evidenceMessageIds },
        tenantId: input.tenantId,
        venueId: input.venueId,
        sessionId: 'session-1',
      },
      select: { id: true },
    })
  })

  it('allows repeated valid evidence IDs while retaining their ordered audit payload', async () => {
    const repeatedEvidenceMessageIds = [input.evidenceMessageIds[0]!, input.evidenceMessageIds[0]!]
    mocks.messageFind.mockResolvedValueOnce([{ id: repeatedEvidenceMessageIds[0] }])

    await expect(
      app.createCaller(context()).admin.createKnowledgeProposal({
        ...input,
        operationId: '44444444-4444-4444-8444-444444444444',
        evidenceMessageIds: repeatedEvidenceMessageIds,
      }),
    ).resolves.toMatchObject({ status: 'PENDING_REVIEW', replayed: false })

    expect(mocks.messageFind).toHaveBeenCalledWith({
      where: {
        id: { in: [repeatedEvidenceMessageIds[0]] },
        tenantId: input.tenantId,
        venueId: input.venueId,
        sessionId: 'session-1',
      },
      select: { id: true },
    })
    expect(mocks.proposalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ evidenceMessageIds: repeatedEvidenceMessageIds }),
      }),
    )
  })

  it('allows the existing empty-evidence generic proposal path without a message lookup', async () => {
    await expect(
      app.createCaller(context()).admin.createKnowledgeProposal({
        ...input,
        operationId: '33333333-3333-4333-8333-333333333333',
        evidenceMessageIds: [],
      }),
    ).resolves.toMatchObject({ status: 'PENDING_REVIEW', replayed: false })
    expect(mocks.messageFind).not.toHaveBeenCalled()
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

  it('creates only an inert temporal OperationalUpdate DRAFT through the canonical action', async () => {
    const desired = {
      title: 'Atrium closure',
      category: 'TEMPORARY_CLOSURE',
      content: 'The atrium is closed for maintenance.',
      isEnabled: true,
    }
    mocks.semanticPreview.mockResolvedValueOnce({
      proposalStatus: 'APPROVED',
      previewHash: 'b'.repeat(64),
      classification: 'TEMPORAL',
      venuePackagePatch: null,
      operationalUpdateDraft: {
        updateType: 'TEMPORARY_CLOSURE',
        severity: 'INFO',
        priority: 'NORMAL',
        title: desired.title,
        body: desired.content,
        startsAt: '2030-01-01T08:00:00.000Z',
        expiresAt: '2030-01-01T12:00:00.000Z',
        status: 'DRAFT',
        autoSchedule: false,
        autoPublish: false,
      },
    })

    await expect(
      app.createCaller(context()).admin.createSemanticOperationalUpdateDraft({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        proposalId: operationId,
        expectedUpdatedAt: new Date('2026-08-25T13:00:00.000Z'),
        expectedPreviewHash: 'b'.repeat(64),
        relation: 'NEW_FACT',
        desired,
        validFrom: '2030-01-01T08:00:00.000Z',
        validUntil: '2030-01-01T12:00:00.000Z',
        operationalUpdateType: 'TEMPORARY_CLOSURE',
      }),
    ).resolves.toEqual({
      operationalUpdateId: '44444444-4444-4444-8444-444444444444',
      operationalUpdateStatus: 'DRAFT',
      replayed: false,
      previewHash: 'b'.repeat(64),
      classification: 'TEMPORAL',
      autoScheduled: false,
      autoPublished: false,
    })

    expect(mocks.createOperationalUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        id: expect.stringMatching(/^[a-f0-9-]{36}$/u),
        actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
        schedule: false,
        fields: expect.objectContaining({
          venueId: 'venue-1',
          updateType: 'TEMPORARY_CLOSURE',
        }),
        finalizer: expect.any(Function),
      }),
      expect.anything(),
    )
  })

  it('persists one exact semantic conflict through the existing AgentQuestion action', async () => {
    const desired = {
      title: 'Museum hours',
      category: 'HOURS',
      content: 'Open 10–6 daily.',
      isEnabled: true,
    }
    mocks.semanticPreview.mockResolvedValueOnce({
      proposalStatus: 'APPROVED',
      previewHash: 'c'.repeat(64),
      classification: 'CONFLICT',
      evidenceRefs: ['source-evidence:evidence-1:abc'],
      blockers: [
        {
          code: 'LOWER_AUTHORITY_CONFLICT',
          path: 'evidence',
          message: 'Lower-authority evidence requires clarification.',
        },
      ],
      questions: [
        {
          owner: 'VENUE_OPERATOR',
          prompt: 'Which hours information should visitors receive for “Museum hours”?',
          blockerCodes: ['LOWER_AUTHORITY_CONFLICT'],
        },
      ],
      venuePackagePatch: null,
      operationalUpdateDraft: null,
    })

    await expect(
      app.createCaller(context()).admin.createSemanticConflictQuestion({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        proposalId: operationId,
        expectedUpdatedAt: new Date('2026-08-25T13:00:00.000Z'),
        expectedPreviewHash: 'c'.repeat(64),
        relation: 'CORRECTS',
        desired,
        agentIdentityId: 'content-agent-1',
      }),
    ).resolves.toEqual({
      questionId: 'question-1',
      questionStatus: 'PENDING',
      replayed: false,
      previewHash: 'c'.repeat(64),
      executionTriggered: false,
      approvalGranted: false,
      canonicalKnowledgeChanged: false,
    })
    expect(mocks.identityFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'content-agent-1',
          enabled: true,
          agentType: 'CONTENT',
        }),
      }),
    )
    expect(mocks.askQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
        questionType: 'LONG_TEXT',
        category: 'semantic-update-conflict',
        blocking: true,
        callbackMetadata: expect.objectContaining({
          proposalId: operationId,
          previewHash: 'c'.repeat(64),
        }),
      }),
      expect.anything(),
    )
  })

  it('rejects a stale semantic conflict preview before selecting an agent identity', async () => {
    mocks.semanticPreview.mockResolvedValueOnce({
      proposalStatus: 'APPROVED',
      previewHash: 'd'.repeat(64),
      classification: 'CONFLICT',
      evidenceRefs: [],
      blockers: [],
      questions: [
        {
          owner: 'VENUE_OPERATOR',
          prompt: 'Which hours are correct?',
          blockerCodes: ['LOWER_AUTHORITY_CONFLICT'],
        },
      ],
      venuePackagePatch: null,
      operationalUpdateDraft: null,
    })

    await expect(
      app.createCaller(context()).admin.createSemanticConflictQuestion({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        proposalId: operationId,
        expectedUpdatedAt: new Date('2026-08-25T13:00:00.000Z'),
        expectedPreviewHash: 'c'.repeat(64),
        relation: 'CORRECTS',
        desired: {
          title: 'Museum hours',
          category: 'HOURS',
          content: 'Open 10–6 daily.',
          isEnabled: true,
        },
        agentIdentityId: 'content-agent-1',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.identityFind).not.toHaveBeenCalled()
    expect(mocks.askQuestion).not.toHaveBeenCalled()
  })

  it('rejects an identity outside the enabled scoped Content draft policy', async () => {
    mocks.semanticPreview.mockResolvedValueOnce({
      proposalStatus: 'APPROVED',
      previewHash: 'c'.repeat(64),
      classification: 'CONFLICT',
      evidenceRefs: [],
      blockers: [],
      questions: [
        {
          owner: 'VENUE_OPERATOR',
          prompt: 'Which hours are correct?',
          blockerCodes: ['LOWER_AUTHORITY_CONFLICT'],
        },
      ],
      venuePackagePatch: null,
      operationalUpdateDraft: null,
    })
    mocks.identityFind.mockResolvedValueOnce(null)

    await expect(
      app.createCaller(context()).admin.createSemanticConflictQuestion({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        proposalId: operationId,
        expectedUpdatedAt: new Date('2026-08-25T13:00:00.000Z'),
        expectedPreviewHash: 'c'.repeat(64),
        relation: 'CORRECTS',
        desired: {
          title: 'Museum hours',
          category: 'HOURS',
          content: 'Open 10–6 daily.',
          isEnabled: true,
        },
        agentIdentityId: 'wrong-agent',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.askQuestion).not.toHaveBeenCalled()
  })

  it('returns the exact answered conflict question and eligible identities with the preview', async () => {
    mocks.semanticPreview.mockResolvedValueOnce({
      proposalStatus: 'APPROVED',
      previewHash: 'c'.repeat(64),
      classification: 'CONFLICT',
      evidenceRefs: [],
      blockers: [],
      questions: [
        {
          owner: 'VENUE_OPERATOR',
          prompt: 'Which hours are correct?',
          blockerCodes: ['LOWER_AUTHORITY_CONFLICT'],
        },
      ],
      venuePackagePatch: null,
      operationalUpdateDraft: null,
    })
    const answeredAt = new Date('2026-08-25T15:00:00.000Z')
    mocks.agentQuestionFind.mockResolvedValueOnce({
      id: 'question-1',
      agentIdentityId: 'content-agent-1',
      status: 'ANSWERED',
      answer: 'Use the signed hours sheet.',
      answeredAt,
      updatedAt: answeredAt,
    })
    mocks.identitiesFind.mockResolvedValueOnce([
      { id: 'content-agent-1', identityKey: 'content-steward', name: 'Content Steward' },
    ])

    const result = await app.createCaller(context()).admin.previewSemanticVenueUpdate({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      proposalId: operationId,
      expectedUpdatedAt: new Date('2026-08-25T13:00:00.000Z'),
      relation: 'CORRECTS',
      desired: {
        title: 'Museum hours',
        category: 'HOURS',
        content: 'Open 10–6 daily.',
        isEnabled: true,
      },
    })

    expect(result).toMatchObject({
      conflictQuestion: {
        id: 'question-1',
        status: 'ANSWERED',
        answer: 'Use the signed hours sheet.',
        answerHash: 'd4e4c404ef4019636ad420aefe855ec91174b0e8267a4341101f972b6807f424',
      },
      questionAgentIdentities: [
        { id: 'content-agent-1', identityKey: 'content-steward', name: 'Content Steward' },
      ],
    })
    expect(mocks.agentQuestionFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          operationId: '32afb343-d542-5328-89da-7a5cf9293b6f',
        },
      }),
    )
  })

  it('returns only an exact temporal DRAFT replay', async () => {
    const desired = {
      title: 'Atrium closure',
      category: 'TEMPORARY_CLOSURE',
      content: 'The atrium is closed for maintenance.',
      isEnabled: true,
    }
    const temporalPreview = {
      proposalStatus: 'APPROVED',
      previewHash: 'b'.repeat(64),
      classification: 'TEMPORAL',
      venuePackagePatch: null,
      operationalUpdateDraft: {
        updateType: 'TEMPORARY_CLOSURE',
        severity: 'INFO',
        priority: 'NORMAL',
        title: desired.title,
        body: desired.content,
        startsAt: '2030-01-01T08:00:00.000Z',
        expiresAt: '2030-01-01T12:00:00.000Z',
        status: 'DRAFT',
        autoSchedule: false,
        autoPublish: false,
      },
    }
    mocks.semanticPreview.mockResolvedValueOnce(temporalPreview)
    mocks.operationalHandoffFind.mockResolvedValueOnce({
      previewHash: temporalPreview.previewHash,
      operationalUpdate: {
        id: '44444444-4444-4444-8444-444444444444',
        status: 'DRAFT',
        isActive: false,
        updateType: 'TEMPORARY_CLOSURE',
        severity: 'INFO',
        priority: 'NORMAL',
        title: desired.title,
        body: desired.content,
        startsAt: new Date('2030-01-01T08:00:00.000Z'),
        expiresAt: new Date('2030-01-01T12:00:00.000Z'),
      },
    })

    await expect(
      app.createCaller(context()).admin.createSemanticOperationalUpdateDraft({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        proposalId: operationId,
        expectedUpdatedAt: new Date('2026-08-25T13:00:00.000Z'),
        expectedPreviewHash: temporalPreview.previewHash,
        relation: 'NEW_FACT',
        desired,
        validFrom: '2030-01-01T08:00:00.000Z',
        validUntil: '2030-01-01T12:00:00.000Z',
        operationalUpdateType: 'TEMPORARY_CLOSURE',
      }),
    ).resolves.toMatchObject({ replayed: true, operationalUpdateStatus: 'DRAFT' })
    expect(mocks.createOperationalUpdate).not.toHaveBeenCalled()
  })

  it('reconciles an exact temporal DRAFT created by a concurrent request', async () => {
    const desired = {
      title: 'Atrium closure',
      category: 'TEMPORARY_CLOSURE',
      content: 'The atrium is closed for maintenance.',
      isEnabled: true,
    }
    const temporalPreview = {
      proposalStatus: 'APPROVED',
      previewHash: 'b'.repeat(64),
      classification: 'TEMPORAL',
      venuePackagePatch: null,
      operationalUpdateDraft: {
        updateType: 'TEMPORARY_CLOSURE',
        severity: 'INFO',
        priority: 'NORMAL',
        title: desired.title,
        body: desired.content,
        startsAt: '2030-01-01T08:00:00.000Z',
        expiresAt: '2030-01-01T12:00:00.000Z',
        status: 'DRAFT',
        autoSchedule: false,
        autoPublish: false,
      },
    }
    mocks.semanticPreview.mockResolvedValueOnce(temporalPreview)
    mocks.createOperationalUpdate.mockRejectedValueOnce({ code: 'P2002' })
    mocks.operationalHandoffFind.mockResolvedValueOnce(null).mockResolvedValueOnce({
      previewHash: temporalPreview.previewHash,
      operationalUpdate: {
        id: '44444444-4444-4444-8444-444444444444',
        status: 'DRAFT',
        isActive: false,
        updateType: 'TEMPORARY_CLOSURE',
        severity: 'INFO',
        priority: 'NORMAL',
        title: desired.title,
        body: desired.content,
        startsAt: new Date('2030-01-01T08:00:00.000Z'),
        expiresAt: new Date('2030-01-01T12:00:00.000Z'),
      },
    })

    await expect(
      app.createCaller(context()).admin.createSemanticOperationalUpdateDraft({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        proposalId: operationId,
        expectedUpdatedAt: new Date('2026-08-25T13:00:00.000Z'),
        expectedPreviewHash: temporalPreview.previewHash,
        relation: 'NEW_FACT',
        desired,
        validFrom: '2030-01-01T08:00:00.000Z',
        validUntil: '2030-01-01T12:00:00.000Z',
        operationalUpdateType: 'TEMPORARY_CLOSURE',
      }),
    ).resolves.toMatchObject({ replayed: true, operationalUpdateStatus: 'DRAFT' })
  })

  it('enforces operational title and body limits before temporal DRAFT creation', async () => {
    await expect(
      app.createCaller(context()).admin.createSemanticOperationalUpdateDraft({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        proposalId: operationId,
        expectedUpdatedAt: new Date('2026-08-25T13:00:00.000Z'),
        expectedPreviewHash: 'b'.repeat(64),
        relation: 'NEW_FACT',
        desired: {
          title: 'x'.repeat(61),
          category: 'TEMPORARY_CLOSURE',
          content: 'y'.repeat(301),
          isEnabled: true,
        },
        validFrom: '2030-01-01T08:00:00.000Z',
        validUntil: '2030-01-01T12:00:00.000Z',
        operationalUpdateType: 'TEMPORARY_CLOSURE',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.semanticPreview).not.toHaveBeenCalled()
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

  it('routes a full typed semantic draft without granting publication authority', async () => {
    const desired = {
      title: 'Museum hours',
      category: 'POLICY',
      content: 'Open 9–5 daily.',
      isEnabled: true,
    }
    await expect(
      app.createCaller(context()).admin.createSemanticUniversalContentDraft({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        proposalId: operationId,
        expectedProposalUpdatedAt: '2026-08-25T13:00:00.000Z',
        expectedPreviewHash: 'a'.repeat(64),
        relation: 'CORRECTS',
        desired,
        draft: {
          audience: 'PUBLIC',
          evidence: [],
          payload: {
            kind: 'POLICY',
            title: desired.title,
            rule: desired.content,
            appliesTo: [],
          },
        },
      }),
    ).resolves.toMatchObject({
      revisionId: 'revision-2',
      requiresExplicitPublication: true,
      autoPublished: false,
    })
    expect(mocks.createUniversalDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        input: expect.objectContaining({
          desired,
          draft: expect.objectContaining({ audience: 'PUBLIC' }),
        }),
      }),
    )
  })
  it('returns the saved replacement wording and relation without exposing the resolution record', async () => {
    const desired = {
      title: 'Gallery access',
      category: 'ACCESS',
      content: 'Use the east door.',
      isEnabled: false,
    }
    mocks.proposalList.mockResolvedValueOnce([
      {
        id: operationId,
        supportRequestId: null,
        supportRequestVersion: null,
        targetKnowledgeEntry: {
          contentModuleId: 'native-module',
          contentRevisionId: 'native-revision',
          contentPublicationId: 'native-publication',
        },
        producedByConflictResolution: {
          desired,
          relation: 'SUPERSEDES',
          proposal: { supportRequestId: 'support-original', supportRequestVersion: 4 },
        },
      },
      {
        id: 'direct',
        supportRequestId: 'support-direct',
        supportRequestVersion: 3,
        targetKnowledgeEntry: {
          contentModuleId: null,
          contentRevisionId: null,
          contentPublicationId: null,
        },
        producedByConflictResolution: null,
      },
      {
        id: 'ordinary',
        supportRequestId: null,
        supportRequestVersion: null,
        targetKnowledgeEntry: null,
        producedByConflictResolution: null,
      },
    ])
    const rows = await app
      .createCaller(context())
      .admin.listKnowledgeProposals({ tenantId: 'tenant-1', venueId: 'venue-1' })
    expect(rows).toEqual([
      {
        id: operationId,
        supportRequestId: null,
        supportRequestVersion: null,
        duplicateResolution: null,
        canRecordReviewedDecline: false,
        reviewedDecline: null,
        hasSupportProvenance: true,
        hasLegacyTarget: false,
        resolutionDraft: { desired, relation: 'SUPERSEDES' },
      },
      {
        id: 'direct',
        supportRequestId: 'support-direct',
        supportRequestVersion: 3,
        duplicateResolution: null,
        canRecordReviewedDecline: false,
        reviewedDecline: null,
        hasSupportProvenance: true,
        hasLegacyTarget: true,
        resolutionDraft: null,
      },
      {
        id: 'ordinary',
        supportRequestId: null,
        supportRequestVersion: null,
        duplicateResolution: null,
        canRecordReviewedDecline: false,
        reviewedDecline: null,
        hasSupportProvenance: false,
        hasLegacyTarget: false,
        resolutionDraft: null,
      },
    ])
    expect(mocks.proposalList).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', venueId: 'venue-1' },
        select: expect.objectContaining({
          producedByConflictResolution: {
            select: {
              desired: true,
              relation: true,
              proposal: { select: { supportRequestId: true, supportRequestVersion: true } },
            },
          },
          targetKnowledgeEntry: {
            select: {
              contentModuleId: true,
              contentRevisionId: true,
              contentPublicationId: true,
            },
          },
          duplicateResolution: {
            select: {
              id: true,
              proposalUpdatedAt: true,
              targetKnowledgeEntryId: true,
              relation: true,
              createdAt: true,
            },
          },
        }),
      }),
    )
  })

  it('projects a durable duplicate receipt separately from current fulfillment', async () => {
    const current = new Date('2026-09-10T12:00:00.000Z')
    mocks.proposalList.mockResolvedValueOnce([
      {
        id: 'current-duplicate',
        status: 'APPROVED',
        updatedAt: current,
        duplicateResolution: {
          id: 'resolution-current',
          proposalUpdatedAt: current,
          targetKnowledgeEntryId: 'target-current',
          relation: 'CORRECTS',
          createdAt: new Date('2026-09-10T11:00:00.000Z'),
        },
        producedByConflictResolution: null,
        targetKnowledgeEntry: null,
      },
      {
        id: 'historical-duplicate',
        status: 'PUBLISHED',
        updatedAt: current,
        duplicateResolution: {
          id: 'resolution-historical',
          proposalUpdatedAt: new Date('2026-09-10T11:59:59.000Z'),
          targetKnowledgeEntryId: 'target-historical',
          relation: 'SUPERSEDES',
          createdAt: new Date('2026-09-10T11:00:00.000Z'),
        },
        producedByConflictResolution: null,
        targetKnowledgeEntry: null,
      },
      {
        id: 'no-duplicate',
        status: 'APPROVED',
        updatedAt: current,
        duplicateResolution: null,
        producedByConflictResolution: null,
        targetKnowledgeEntry: null,
      },
    ])

    const rows = await app
      .createCaller(context())
      .admin.listKnowledgeProposals({ tenantId: 'tenant-1', venueId: 'venue-1' })
    expect(rows).toMatchObject([
      {
        id: 'current-duplicate',
        duplicateResolution: {
          resolutionId: 'resolution-current',
          outcome: 'DUPLICATE_NOOP',
          targetKnowledgeEntryId: 'target-current',
          relation: 'CORRECTS',
          proposalRevisionCurrent: true,
          currentFulfillmentVerified: false,
        },
      },
      {
        id: 'historical-duplicate',
        duplicateResolution: {
          resolutionId: 'resolution-historical',
          proposalRevisionCurrent: false,
          currentFulfillmentVerified: false,
        },
      },
      { id: 'no-duplicate', duplicateResolution: null },
    ])
    expect(rows[0]?.duplicateResolution).not.toHaveProperty('proposalUpdatedAt')
  })
  it('projects exact decline eligibility and bounded historical receipt metadata', async () => {
    const updatedAt = new Date('2026-09-10T12:00:00.000Z')
    const base = {
      id: operationId,
      status: 'REJECTED',
      updatedAt,
      supportRequestId: 'request-1',
      supportRequestVersion: 2,
      producedByConflictResolution: null,
      targetKnowledgeEntry: null,
      conflictResolutions: [],
      reviewedDecline: null,
    }
    mocks.proposalList.mockResolvedValueOnce([
      base,
      { ...base, id: 'retired', conflictResolutions: [{ id: 'conflict' }] },
      {
        ...base,
        id: 'recorded',
        reviewedDecline: {
          id: 'decline',
          reviewedProposalUpdatedAt: updatedAt,
          createdAt: updatedAt,
        },
      },
      {
        ...base,
        id: 'changed',
        reviewedDecline: {
          id: 'decline-stale',
          reviewedProposalUpdatedAt: new Date(0),
          createdAt: updatedAt,
        },
      },
      { ...base, id: 'not-support', supportRequestId: null, supportRequestVersion: null },
    ])
    const rows = await app
      .createCaller(context())
      .admin.listKnowledgeProposals({ tenantId: 'tenant-1', venueId: 'venue-1' })
    expect(rows.map((row) => row.canRecordReviewedDecline)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ])
    expect(rows[2]?.reviewedDecline).toEqual({
      resolutionId: 'decline',
      outcome: 'REVIEWED_DECLINE',
      createdAt: updatedAt,
      proposalRevisionCurrent: true,
      currentFulfillmentVerified: false,
    })
    expect(rows[3]?.reviewedDecline?.proposalRevisionCurrent).toBe(false)
    expect(rows[1]).not.toHaveProperty('conflictResolutions')
    expect(rows[2]?.reviewedDecline).not.toHaveProperty('reviewedProposalUpdatedAt')
  })

  it('denies non-admin access to the explicit decline action', async () => {
    const ctx = context()
    const nonAdmin = { ...ctx, session: { ...ctx.session!, isPlatformAdmin: false } } as TRPCContext
    await expect(
      app.createCaller(nonAdmin).admin.recordSupportReviewedDecline({
        operationId,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        proposalId: operationId,
        expectedProposalUpdatedAt: '2026-09-10T12:00:00.000Z',
        resolutionNote: 'Do not apply this change.',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
