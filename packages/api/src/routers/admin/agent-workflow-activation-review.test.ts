import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  bypass: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  versions: vi.fn(),
  requests: vi.fn(),
  identities: vi.fn(),
  assessments: vi.fn(),
  events: vi.fn(),
  heads: vi.fn(),
}))
vi.mock('@pathfinder/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/db')>()
  return {
    ...actual,
    assertVenueAvailable: mocks.available,
    isVenueUnavailableError: (error: unknown) =>
      error instanceof Error && error.name === 'VenueUnavailableError',
    withTenantIsolationBypass: mocks.bypass,
    db: {
      agentWorkflowVersion: { findMany: mocks.versions },
      approvalRequest: { findMany: mocks.requests },
      agentIdentity: { findMany: mocks.identities },
      agentWorkflowPromotionAssessment: { findFirst: mocks.assessments },
      agentWorkflowActivationEvent: { findMany: mocks.events },
      agentWorkflowActivationHead: { findMany: mocks.heads },
    },
  }
})
vi.mock('../../mcp/composition', () => ({
  createSafeOperationalMcpRegistry: () => ({
    listTools: () => [{ _meta: { 'com.pathfinder/security': { capability: 'resources:read' } } }],
  }),
}))

import type { TRPCContext } from '../../context'
import { adminAgentWorkflowActivationReviewRouter } from './agent-workflow-activation-review'

const scope = { tenantId: 'tenant-one', venueId: 'venue-one' }
const createdAt = new Date('2026-09-07T12:00:00Z')
const policy = {
  numerator: 1,
  denominator: 10,
  salt: 'reviewed-canary-salt',
  startsAt: '2026-09-07T00:00:00Z',
  endsAt: '2026-09-08T00:00:00Z',
  maxSelectedRuns: 5,
  eligibleRunTypes: ['QUALITY_REVIEW'],
  eligibleOperations: ['operator_task'],
  skippedBaseline: { kind: 'NO_WORKFLOW' as const },
  supportedActionClasses: ['RUN_TERMINAL_WRITE' as const],
}
const receipt = {
  registryKey: 'grounded-review',
  workflowVersionId: '22222222-2222-4222-8222-222222222222',
  promotionAssessmentId: 'assessment-one',
  expectedHeadRevision: 0,
  canaryPolicy: policy,
  evidenceDigest: 'a'.repeat(64),
}
function caller(admin = true) {
  return adminAgentWorkflowActivationReviewRouter.createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator-one',
      activeTenantId: 'other-tenant',
      role: 'STAFF',
      isPlatformAdmin: admin,
    },
  } as TRPCContext)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.available.mockResolvedValue(undefined)
  mocks.versions.mockResolvedValue([])
  mocks.requests.mockResolvedValue([])
  mocks.identities.mockResolvedValue([])
  mocks.assessments.mockResolvedValue(null)
  mocks.events.mockResolvedValue([])
  mocks.heads.mockResolvedValue([])
})

describe('workflow activation review read model', () => {
  it('requires platform admin authority before scoped reads', async () => {
    await expect(caller(false).getAgentWorkflowActivationReview(scope)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(mocks.available).not.toHaveBeenCalled()
    expect(mocks.versions).not.toHaveBeenCalled()
  })

  it('returns bounded summaries, approved receipt correlation, and applied event readback', async () => {
    const versionId = receipt.workflowVersionId
    const decision = {
      id: 'decision-one',
      decision: 'APPROVED',
      decidedByType: 'HUMAN',
      decidedById: 'reviewer-one',
      reason: 'Approved.',
      createdAt,
    }
    mocks.versions.mockResolvedValue([
      {
        id: versionId,
        registryKey: receipt.registryKey,
        version: 1,
        kind: 'WORKFLOW',
        status: 'REGISTERED_UNACTIVATED',
        manifestHash: 'b'.repeat(64),
        contentHash: 'c'.repeat(64),
        requiredToolCapabilities: ['resources:read'],
        createdByType: 'HUMAN',
        createdById: 'author-one',
        createdAt,
      },
    ])
    mocks.requests.mockResolvedValue([
      {
        id: 'request-one',
        agentIdentityId: 'identity-one',
        requestedByType: 'HUMAN',
        requestedById: 'operator-one',
        proposedAction: 'agent-workflow.activate',
        scopeSnapshot: receipt,
        reason: 'Review activation.',
        riskCategory: 'HIGH',
        artifacts: [{ kind: 'WORKFLOW_APPROVAL_REQUEST', fingerprint: 'd'.repeat(64) }],
        expiresAt: null,
        createdAt,
        decision,
      },
    ])
    mocks.identities.mockResolvedValue([
      { id: 'identity-one', identityKey: 'reviewer', name: 'Reviewer' },
    ])
    mocks.assessments.mockResolvedValue({
      id: 'assessment-one',
      outcome: 'EVIDENCE_READY_REVIEW_REQUIRED',
      assessmentHash: 'e'.repeat(64),
      diagnostics: {},
      createdAt,
    })
    mocks.events.mockResolvedValue([
      {
        id: 'event-one',
        registryKey: receipt.registryKey,
        kind: 'ACTIVATE',
        resultingRevision: 1,
        eventHash: 'f'.repeat(64),
        approvalDecisionId: decision.id,
        createdAt,
      },
    ])
    mocks.heads.mockResolvedValue([
      {
        registryKey: receipt.registryKey,
        revision: 1,
        activeVersionId: versionId,
        activationEventId: 'event-one',
      },
    ])

    const result = await caller().getAgentWorkflowActivationReview({ ...scope, limit: 20 })
    expect(result.candidates[0]).toMatchObject({
      version: { id: versionId, artifactIntegrity: 'NOT_CHECKED_BODY_ON_APPLY' },
      compatibility: { status: 'CURRENTLY_AVAILABLE', missingCapabilities: [] },
      assessment: {
        diagnosticsShapeValid: false,
        applicability: 'HISTORICAL_EVIDENCE_APPLY_REVALIDATES',
      },
    })
    expect(result.approvalRequests[0]).toMatchObject({
      receiptShapeValid: true,
      artifactShapeValid: true,
      reviewedApplyInput: null,
      appliedEventCorrelation: 'APPLIED',
      appliedEvent: { id: 'event-one' },
    })
    expect(JSON.stringify(mocks.versions.mock.calls[0]?.[0].select)).not.toContain('portableText')
    expect(mocks.versions.mock.calls[0]?.[0]).toMatchObject({
      where: scope,
      take: 21,
    })
    expect(mocks.requests.mock.calls[0]?.[0]).toMatchObject({
      where: {
        ...scope,
        proposedAction: { in: expect.arrayContaining(['agent-workflow.activate']) },
      },
      take: 21,
    })
    expect(mocks.identities.mock.calls[0]?.[0]).toMatchObject({
      where: { ...scope, enabled: true },
      take: 51,
      select: { id: true, identityKey: true, name: true },
    })
    expect(mocks.events.mock.calls[0]?.[0]).toMatchObject({
      where: { ...scope, approvalDecisionId: decision.id },
      take: 2,
    })
  })

  it('paginates equally-timed rows and suppresses malformed receipt contents', async () => {
    mocks.versions.mockResolvedValue([
      {
        id: '22222222-2222-4222-8222-222222222222',
        registryKey: 'one',
        requiredToolCapabilities: [],
        createdAt,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        registryKey: 'two',
        requiredToolCapabilities: [],
        createdAt,
      },
    ])
    mocks.requests.mockResolvedValue([
      {
        id: 'request-one',
        agentIdentityId: 'identity-one',
        requestedByType: 'HUMAN',
        requestedById: 'operator-one',
        proposedAction: 'agent-workflow.rollback',
        scopeSnapshot: { secret: 'must-not-return' },
        reason: 'Malformed.',
        riskCategory: 'HIGH',
        artifacts: [],
        expiresAt: null,
        createdAt,
        decision: null,
      },
      { id: 'request-two', createdAt },
    ])
    mocks.identities.mockResolvedValue(
      Array.from({ length: 51 }, (_, index) => ({
        id: `identity-${index}`,
        identityKey: `key-${index}`,
        name: `Name ${index}`,
      })),
    )
    const result = await caller().getAgentWorkflowActivationReview({
      ...scope,
      limit: 1,
      candidateBefore: {
        id: '44444444-4444-4444-8444-444444444444',
        createdAt: createdAt.toISOString(),
      },
      requestBefore: { id: 'request-cursor', createdAt: createdAt.toISOString() },
    })
    expect(result.nextCandidateBefore).toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      createdAt: createdAt.toISOString(),
    })
    expect(result.nextRequestBefore).toEqual({
      id: 'request-one',
      createdAt: createdAt.toISOString(),
    })
    expect(result.identitiesTruncated).toBe(true)
    expect(result.enabledIdentities).toHaveLength(50)
    expect(result.approvalRequests[0]).toMatchObject({
      receiptShapeValid: false,
      receipt: null,
      reviewedApplyInput: null,
    })
    expect(JSON.stringify(result)).not.toContain('must-not-return')
    expect(mocks.versions.mock.calls[0]?.[0].where.OR).toEqual([
      { createdAt: { lt: createdAt } },
      { createdAt, id: { lt: '44444444-4444-4444-8444-444444444444' } },
    ])
  })

  it.each([
    {
      name: 'expired approval',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
      decidedByType: 'HUMAN',
      decision: 'APPROVED',
    },
    { name: 'machine approval', expiresAt: null, decidedByType: 'AGENT', decision: 'APPROVED' },
    { name: 'rejected decision', expiresAt: null, decidedByType: 'HUMAN', decision: 'REJECTED' },
    { name: 'cancelled decision', expiresAt: null, decidedByType: 'HUMAN', decision: 'CANCELLED' },
  ])('does not present $name as reviewed apply input', async (variant) => {
    mocks.requests.mockResolvedValue([
      {
        id: 'request-one',
        agentIdentityId: 'identity-one',
        requestedByType: 'HUMAN',
        requestedById: 'operator-one',
        proposedAction: 'agent-workflow.activate',
        scopeSnapshot: receipt,
        reason: 'Historical approval.',
        riskCategory: 'HIGH',
        artifacts: [{ kind: 'WORKFLOW_APPROVAL_REQUEST', fingerprint: 'd'.repeat(64) }],
        expiresAt: variant.expiresAt,
        createdAt,
        decision: {
          id: 'decision-one',
          decision: variant.decision,
          decidedByType: variant.decidedByType,
          decidedById: 'agent-one',
          reason: null,
          createdAt,
        },
      },
    ])
    const result = await caller().getAgentWorkflowActivationReview(scope)
    expect(result.approvalRequests[0]).toMatchObject({
      receiptShapeValid: true,
      decision: { decision: variant.decision, decidedByType: variant.decidedByType },
      reviewedApplyInput: null,
    })
  })

  it('offers exact reviewed input only for a valid unapplied human decision', async () => {
    mocks.requests.mockResolvedValue([
      {
        id: 'request-one',
        agentIdentityId: 'identity-one',
        requestedByType: 'HUMAN',
        requestedById: 'operator-one',
        proposedAction: 'agent-workflow.activate',
        scopeSnapshot: receipt,
        reason: 'Reviewed.',
        riskCategory: 'HIGH',
        artifacts: [{ kind: 'WORKFLOW_APPROVAL_REQUEST', fingerprint: 'd'.repeat(64) }],
        expiresAt: null,
        createdAt,
        decision: {
          id: 'decision-one',
          decision: 'APPROVED',
          decidedByType: 'HUMAN',
          decidedById: 'reviewer-one',
          reason: 'Approved.',
          createdAt,
        },
      },
    ])
    const result = await caller().getAgentWorkflowActivationReview(scope)
    expect(result.approvalRequests[0]).toMatchObject({
      reviewedApplyInput: { approvalDecisionId: 'decision-one', receipt },
      appliedEventCorrelation: 'NONE',
      appliedEvent: null,
    })
  })
})
