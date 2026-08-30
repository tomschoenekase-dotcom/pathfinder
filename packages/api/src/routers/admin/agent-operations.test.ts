import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  agentIdentityFindMany: vi.fn(),
  agentIdentityFindFirst: vi.fn(),
  agentRunFindMany: vi.fn(),
  agentRunFindFirst: vi.fn(),
  agentActionFindMany: vi.fn(),
  agentTimelineEventFindMany: vi.fn(),
  approvalRequestFindMany: vi.fn(),
  approvalRequestFindFirst: vi.fn(),
  approvalGrantFindMany: vi.fn(),
  transactionApprovalFindFirst: vi.fn(),
  transactionPackageFindFirst: vi.fn(),
  transactionSupportRequestFindFirst: vi.fn(),
  dbTransaction: vi.fn(),
  issueApprovalGrant: vi.fn(),
  revokeApprovalGrant: vi.fn(),
  recordDecision: vi.fn(),
  supportPackageDraftPayloadHash: vi.fn(),
  createIdentity: vi.fn(),
  editIdentity: vi.fn(),
  disableIdentity: vi.fn(),
  enableIdentity: vi.fn(),
  requestCancellation: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  AgentRunCancellationError: class AgentRunCancellationError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  requestAgentRunCancellationAction: mocks.requestCancellation,
  AgentIdentityConfigurationError: class AgentIdentityConfigurationError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  ApprovalDecisionActionError: class ApprovalDecisionActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  ApprovalGrantActionError: class ApprovalGrantActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  issueApprovalGrantAction: mocks.issueApprovalGrant,
  revokeApprovalGrantAction: mocks.revokeApprovalGrant,
  recordApprovalDecisionAction: mocks.recordDecision,
  supportPackageDraftPayloadHash: mocks.supportPackageDraftPayloadHash,
  createDisabledAgentIdentity: mocks.createIdentity,
  editDisabledAgentIdentity: mocks.editIdentity,
  disableAgentIdentity: mocks.disableIdentity,
  enableAgentIdentity: mocks.enableIdentity,
  withTenantIsolationBypass: mocks.bypass,
  db: {
    $transaction: mocks.dbTransaction,
    agentIdentity: {
      findMany: mocks.agentIdentityFindMany,
      findFirst: mocks.agentIdentityFindFirst,
    },
    agentRun: { findMany: mocks.agentRunFindMany, findFirst: mocks.agentRunFindFirst },
    agentAction: { findMany: mocks.agentActionFindMany },
    agentTimelineEvent: { findMany: mocks.agentTimelineEventFindMany },
    approvalRequest: {
      findMany: mocks.approvalRequestFindMany,
      findFirst: mocks.approvalRequestFindFirst,
    },
    approvalGrant: { findMany: mocks.approvalGrantFindMany },
  },
}))

import { mergeRouters, router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminAgentApprovalDecisionsRouter } from './agent-approval-decisions'
import { adminAgentOperationsRouter } from './agent-operations'
import { adminAgentIdentityConfigurationRouter } from './agent-identity-configuration'
import { adminAgentRunCancellationRouter } from './agent-run-cancellation'
import { adminSupportOpenPolicyRouter } from './support-open-policy'
import { adminSupportCompletionApprovalRouter } from './support-completion-approval'
import { adminSupportDraftApprovalRouter } from './support-package-draft-approval'
import { adminSupportApplicationApprovalRouter } from './support-package-application-approval'
import { adminSupportReversionApprovalRouter } from './support-package-reversion-approval'
import { adminSupportHandoffSupersessionApprovalRouter } from './support-package-handoff-supersession-approval'
import { supportPackageRollbackManifestDigest } from '../../lib/support-package-reversion-actions'

const testRouter = router({
  agentOperations: mergeRouters(
    adminAgentOperationsRouter,
    adminAgentIdentityConfigurationRouter,
    adminAgentApprovalDecisionsRouter,
    adminAgentRunCancellationRouter,
    adminSupportOpenPolicyRouter,
    adminSupportCompletionApprovalRouter,
    adminSupportDraftApprovalRouter,
    adminSupportApplicationApprovalRouter,
    adminSupportReversionApprovalRouter,
    adminSupportHandoffSupersessionApprovalRouter,
  ),
})

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator_1',
      activeTenantId: 'tenant_other',
      role: 'STAFF',
      isPlatformAdmin,
    },
  }
}

describe('admin agent operations router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.supportPackageDraftPayloadHash.mockReturnValue(
      'e5efbd87162cf2f0e6f2cc81a555123bf9f45809d526c64619e6ec68ef6ad29a',
    )
    mocks.dbTransaction.mockImplementation(async (operation) =>
      operation({
        approvalRequest: { findFirst: mocks.transactionApprovalFindFirst },
        venuePackage: { findFirst: mocks.transactionPackageFindFirst },
        supportRequest: { findFirst: mocks.transactionSupportRequestFindFirst },
      }),
    )
  })

  it('rejects a non-admin before entering the tenant isolation bypass', async () => {
    await expect(
      testRouter.createCaller(context(false)).agentOperations.listAgentRuns({
        tenantId: 'tenant_1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.agentRunFindMany).not.toHaveBeenCalled()
  })

  it('rejects cancellation by a non-admin before bypass or action dispatch', async () => {
    await expect(
      testRouter.createCaller(context(false)).agentOperations.requestAgentRunCancellation({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentRunId: 'run_1',
        reason: 'Stop requested',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.requestCancellation).not.toHaveBeenCalled()
  })

  it('delegates exact run scope and session-derived human admin cancellation intent', async () => {
    const requestedAt = new Date('2026-08-11T20:00:00.000Z')
    mocks.requestCancellation.mockResolvedValue({
      id: 'run_1',
      status: 'RUNNING',
      cancelRequestedAt: requestedAt,
      outcome: 'REQUESTED',
    })
    const result = await testRouter
      .createCaller(context())
      .agentOperations.requestAgentRunCancellation({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentRunId: 'run_1',
        reason: '  Stop requested  ',
      })
    expect(mocks.requestCancellation).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentRunId: 'run_1',
        reason: 'Stop requested',
        actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
      },
      expect.anything(),
    )
    expect(result).toEqual({
      id: 'run_1',
      status: 'RUNNING',
      cancelRequestedAt: requestedAt,
      outcome: 'REQUESTED',
    })
  })

  it('maps scoped cancellation failures without provider or retry behavior', async () => {
    const ErrorClass = (await import('@pathfinder/db')).AgentRunCancellationError
    mocks.requestCancellation.mockRejectedValueOnce(
      new ErrorClass('NOT_FOUND', 'Agent run not found.'),
    )
    await expect(
      testRouter.createCaller(context()).agentOperations.requestAgentRunCancellation({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentRunId: 'run_other',
        reason: 'Stop requested',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    mocks.requestCancellation.mockRejectedValueOnce(new ErrorClass('CONFLICT', 'Run changed.'))
    await expect(
      testRouter.createCaller(context()).agentOperations.requestAgentRunCancellation({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentRunId: 'run_1',
        reason: 'Stop requested',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.requestCancellation).toHaveBeenCalledTimes(2)
  })

  it('rejects staged identity creation by a non-admin before bypass or action dispatch', async () => {
    await expect(
      testRouter.createCaller(context(false)).agentOperations.createDisabledAgentIdentity({
        scope: { level: 'VENUE', tenantId: 'tenant_1', venueId: 'venue_1' },
        fields: {
          identityKey: 'content.primary',
          name: 'Content agent',
          description: null,
          agentType: 'CONTENT',
          accessCapabilities: ['content.draft'],
          autonomyLevel: 'DRAFT',
          autonomousActions: ['content.prepare-draft'],
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.createIdentity).not.toHaveBeenCalled()
  })

  it('passes only parsed exact scope, allowlisted fields, CAS revision, and human admin actor', async () => {
    mocks.editIdentity.mockResolvedValue({ id: 'agent_1', enabled: false })
    const expectedUpdatedAt = new Date('2026-08-11T14:30:00.000Z')
    await testRouter.createCaller(context()).agentOperations.editDisabledAgentIdentity({
      scope: { level: 'CLIENT', tenantId: 'tenant_1' },
      agentIdentityId: 'agent_1',
      expectedUpdatedAt,
      fields: {
        identityKey: 'support.primary',
        name: 'Support agent',
        description: 'Draft-only support assistant.',
        agentType: 'SUPPORT',
        accessCapabilities: ['support.read'],
        autonomyLevel: 'READ_ONLY',
        autonomousActions: [],
      },
    })
    expect(mocks.editIdentity).toHaveBeenCalledWith({
      scope: { level: 'CLIENT', tenantId: 'tenant_1' },
      agentIdentityId: 'agent_1',
      expectedUpdatedAt,
      fields: {
        identityKey: 'support.primary',
        name: 'Support agent',
        description: 'Draft-only support assistant.',
        agentType: 'SUPPORT',
        accessCapabilities: ['support.read'],
        autonomyLevel: 'READ_ONLY',
        autonomousActions: [],
      },
      actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
    })
  })

  it('maps stale identity action conflicts without retrying or enabling execution', async () => {
    const ErrorClass = (await import('@pathfinder/db')).AgentIdentityConfigurationError
    mocks.disableIdentity.mockRejectedValue(
      new ErrorClass('CONFLICT', 'Agent identity configuration changed'),
    )
    await expect(
      testRouter.createCaller(context()).agentOperations.disableAgentIdentity({
        scope: { level: 'VENUE', tenantId: 'tenant_1', venueId: 'venue_1' },
        agentIdentityId: 'agent_1',
        expectedUpdatedAt: new Date('2026-08-11T14:30:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<TRPCError>)
    expect(mocks.disableIdentity).toHaveBeenCalledOnce()
  })

  it('issues only the fixed draft-only policy contract with the session-derived human actor', async () => {
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_1', replayed: false })
    const result = await testRouter
      .createCaller(context())
      .agentOperations.issueOperationalUpdateDraftPolicy({
        operationId: '22222222-2222-4222-8222-222222222222',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentIdentityId: 'agent_1',
        policyKey: 'support-operational-update-drafts',
        issueReason: 'This reviewed workflow has produced safe informational drafts.',
        outcomeObservationIds: ['outcome_1'],
        maxTitleChars: 120,
        maxBodyChars: 2000,
        maxUses: 25,
        expiresAt: new Date('2030-01-02T12:00:00.000Z'),
      })

    expect(result).toEqual({ id: 'grant_1', replayed: false })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith({
      operationId: '22222222-2222-4222-8222-222222222222',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentIdentityId: 'agent_1',
      actionName: 'pathfinder.create_update_draft',
      capability: 'updates:draft',
      mode: 'POLICY_BACKED',
      policyKey: 'support-operational-update-drafts',
      scope: {
        contractVersion: 1,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        effect: 'DRAFT_ONLY',
      },
      constraints: {
        contractVersion: 1,
        effect: 'DRAFT_ONLY',
        allowedUpdateTypes: ['GENERAL_NOTICE'],
        allowedSeverities: ['INFO'],
        allowedPriorities: ['NORMAL'],
        maxTitleChars: 120,
        maxBodyChars: 2000,
      },
      issueReason: 'This reviewed workflow has produced safe informational drafts.',
      outcomeObservationIds: ['outcome_1'],
      maxUses: 25,
      expiresAt: new Date('2030-01-02T12:00:00.000Z'),
      actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
    })
  })

  it('issues the separately bounded internal support-draft policy', async () => {
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_support', replayed: false })
    await testRouter.createCaller(context()).agentOperations.issueSupportRequestDraftPolicy({
      operationId: '44444444-4444-4444-8444-444444444444',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentIdentityId: 'agent_1',
      policyKey: 'support-private-request-drafts',
      issueReason: 'Reviewed outcomes support private support drafting.',
      outcomeObservationIds: ['outcome_1'],
      maxSubjectChars: 180,
      maxBodyChars: 6000,
    })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.create_support_draft',
        capability: 'support:draft',
        mode: 'POLICY_BACKED',
        constraints: {
          contractVersion: 1,
          effect: 'DRAFT_ONLY',
          allowedCategories: [
            'CONTENT_CORRECTION',
            'OPERATIONAL_UPDATE',
            'BRANDING',
            'EXPERIENCE_BEHAVIOR',
            'ACCESSIBILITY',
            'GENERAL',
          ],
          maxSubjectChars: 180,
          maxBodyChars: 6000,
        },
        outcomeObservationIds: ['outcome_1'],
        actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
      }),
    )
  })

  it('issues the separately bounded NOTES-only intake proposal policy', async () => {
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_intake', replayed: false })
    await testRouter.createCaller(context()).agentOperations.issueIntakeNotesProposalPolicy({
      operationId: '54444444-4444-4444-8444-444444444444',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentIdentityId: 'agent_1',
      policyKey: 'onboarding-private-notes-proposals',
      issueReason: 'Reviewed outcomes support notes-only onboarding proposals.',
      outcomeObservationIds: ['outcome_1'],
      maxNotesChars: 8000,
    })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.create_intake_notes_proposal',
        capability: 'intake:draft',
        mode: 'POLICY_BACKED',
        scope: {
          contractVersion: 1,
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          effect: 'PROPOSAL_ONLY',
        },
        constraints: {
          contractVersion: 1,
          effect: 'PROPOSAL_ONLY',
          allowedKinds: ['NOTES'],
          maxNotesChars: 8000,
        },
        outcomeObservationIds: ['outcome_1'],
        actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
      }),
    )
  })

  it('issues exactly one evidence-backed support draft opening', async () => {
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_open', replayed: false })
    await testRouter.createCaller(context()).agentOperations.issueSupportRequestOpenPolicy({
      operationId: '45444444-4444-4444-8444-444444444444',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentIdentityId: 'agent_1',
      policyKey: 'support-request-open-once',
      issueReason: 'Reviewed outcomes justify one internal lifecycle promotion.',
      outcomeObservationIds: ['outcome_1'],
    })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith({
      operationId: '45444444-4444-4444-8444-444444444444',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentIdentityId: 'agent_1',
      actionName: 'pathfinder.open_support_request',
      capability: 'support:open',
      mode: 'POLICY_BACKED',
      policyKey: 'support-request-open-once',
      scope: {
        contractVersion: 1,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        effect: 'DRAFT_TO_OPEN_ONLY',
      },
      constraints: {
        contractVersion: 1,
        effect: 'DRAFT_TO_OPEN_ONLY',
        allowedFromStatuses: ['DRAFT'],
        allowedToStatuses: ['OPEN'],
      },
      issueReason: 'Reviewed outcomes justify one internal lifecycle promotion.',
      outcomeObservationIds: ['outcome_1'],
      maxUses: 1,
      actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
    })
  })

  it('records one support-triage approval and derives exact one-shot authority from its snapshot', async () => {
    mocks.transactionApprovalFindFirst.mockResolvedValue({
      id: 'approval_1',
      agentIdentityId: 'agent_1',
      proposedAction: 'pathfinder.apply_support_triage',
      scopeSnapshot: {
        contractVersion: 1,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestId: 'request_1',
        expectedVersion: 4,
        proposedCategory: 'CONTENT_CORRECTION',
        proposedMissingInformation: ['Current exhibit label photograph'],
        supportRequestChanged: false,
        clientActivityChanged: false,
        customerContacted: false,
        executionAuthorized: false,
      },
      expiresAt: null,
    })
    mocks.recordDecision.mockResolvedValue({ id: 'decision_1', decision: 'APPROVED' })
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_1', replayed: false })
    const result = await testRouter
      .createCaller(context())
      .agentOperations.decideSupportTriageProposal({
        operationId: '47444444-4444-4444-8444-444444444444',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_1',
        decision: 'APPROVED',
        reason: 'Evidence and exact category reviewed.',
      })
    expect(result).toMatchObject({ executionTriggered: false, approvalGrant: { id: 'grant_1' } })
    expect(mocks.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_1',
        decision: 'APPROVED',
        actor: { actorType: 'HUMAN', actorId: 'operator_1', auditRole: 'PLATFORM_ADMIN' },
      }),
      expect.anything(),
    )
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: '47444444-4444-4444-8444-444444444444',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentIdentityId: 'agent_1',
        actionName: 'pathfinder.apply_support_triage',
        capability: 'support:triage',
        mode: 'ONE_SHOT',
        approvalDecisionId: 'decision_1',
        parameters: {
          clientId: 'tenant_1',
          venueId: 'venue_1',
          requestId: 'request_1',
          expectedVersion: 4,
          category: 'CONTENT_CORRECTION',
          missingInformation: ['Current exhibit label photograph'],
        },
      }),
      expect.anything(),
    )
  })

  it('records rejected support triage without issuing execution authority', async () => {
    mocks.transactionApprovalFindFirst.mockResolvedValue({
      id: 'approval_1',
      agentIdentityId: 'agent_1',
      proposedAction: 'pathfinder.apply_support_triage',
      scopeSnapshot: {
        contractVersion: 1,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestId: 'request_1',
        expectedVersion: 4,
        proposedCategory: 'GENERAL',
        proposedMissingInformation: [],
        supportRequestChanged: false,
        clientActivityChanged: false,
        customerContacted: false,
        executionAuthorized: false,
      },
      expiresAt: null,
    })
    mocks.recordDecision.mockResolvedValue({ id: 'decision_1', decision: 'REJECTED' })
    const result = await testRouter
      .createCaller(context())
      .agentOperations.decideSupportTriageProposal({
        operationId: '48444444-4444-4444-8444-444444444444',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_1',
        decision: 'REJECTED',
      })
    expect(result).toMatchObject({ approvalGrant: null, executionTriggered: false })
    expect(mocks.issueApprovalGrant).not.toHaveBeenCalled()
  })

  it('derives exact one-shot client information-request authority from founder approval', async () => {
    mocks.transactionApprovalFindFirst.mockResolvedValue({
      id: 'approval_info_1',
      agentIdentityId: 'agent_1',
      proposedAction: 'pathfinder.apply_support_information_request',
      scopeSnapshot: {
        contractVersion: 1,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestId: 'request_1',
        expectedVersion: 4,
        fromStatus: 'IN_REVIEW',
        toStatus: 'WAITING_FOR_CLIENT',
        body: 'Please provide the current exhibit label photograph.',
        missingInformation: ['Current exhibit label photograph'],
        supportRequestChanged: false,
        clientActivityChanged: false,
        clientVisibleMessageCreated: false,
        customerContacted: false,
        externalDeliveryTriggered: false,
        executionAuthorized: false,
      },
      expiresAt: null,
    })
    mocks.recordDecision.mockResolvedValue({ id: 'decision_info_1', decision: 'APPROVED' })
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_info_1' })
    const result = await testRouter
      .createCaller(context())
      .agentOperations.decideSupportInformationRequestProposal({
        operationId: '49444444-4444-4444-8444-444444444444',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_info_1',
        decision: 'APPROVED',
      })
    expect(result).toMatchObject({
      executionTriggered: false,
      approvalGrant: { id: 'grant_info_1' },
    })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.apply_support_information_request',
        capability: 'support:request-information',
        mode: 'ONE_SHOT',
        scope: expect.objectContaining({ effect: 'EXACT_CLIENT_INFORMATION_REQUEST_ONLY' }),
        parameters: {
          clientId: 'tenant_1',
          venueId: 'venue_1',
          requestId: 'request_1',
          expectedVersion: 4,
          fromStatus: 'IN_REVIEW',
          toStatus: 'WAITING_FOR_CLIENT',
          body: 'Please provide the current exhibit label photograph.',
          missingInformation: ['Current exhibit label photograph'],
        },
        approvalDecisionId: 'decision_info_1',
      }),
      expect.anything(),
    )
  })

  it('derives exact one-shot support-completion authority from founder approval', async () => {
    mocks.transactionApprovalFindFirst.mockResolvedValue({
      id: 'approval_completion_1',
      agentIdentityId: 'agent_1',
      proposedAction: 'pathfinder.apply_support_completion',
      scopeSnapshot: {
        contractVersion: 2,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestId: 'request_1',
        expectedVersion: 5,
        fromStatus: 'IN_REVIEW',
        toStatus: 'COMPLETED',
        body: 'Your requested venue update is complete.',
        missingInformationCount: 0,
        packageFulfillment: {
          contractVersion: 1,
          linkedPackageCount: 0,
          packages: [],
          digest: 'b'.repeat(64),
        },
        allLinkedPackagesApplied: true,
        supportRequestChanged: false,
        clientActivityChanged: false,
        clientVisibleMessageCreated: false,
        customerContacted: false,
        externalDeliveryTriggered: false,
        executionAuthorized: false,
      },
      expiresAt: null,
    })
    mocks.recordDecision.mockResolvedValue({ id: 'decision_completion_1', decision: 'APPROVED' })
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_completion_1' })
    const result = await testRouter
      .createCaller(context())
      .agentOperations.decideSupportCompletionProposal({
        operationId: '50444444-4444-4444-8444-444444444444',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_completion_1',
        decision: 'APPROVED',
      })
    expect(result).toMatchObject({
      executionTriggered: false,
      approvalGrant: { id: 'grant_completion_1' },
    })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.apply_support_completion',
        capability: 'support:complete',
        mode: 'ONE_SHOT',
        scope: expect.objectContaining({
          contractVersion: 2,
          effect: 'EXACT_FULFILLMENT_BOUND_CLIENT_COMPLETION_ONLY',
        }),
        parameters: {
          clientId: 'tenant_1',
          venueId: 'venue_1',
          requestId: 'request_1',
          expectedVersion: 5,
          fromStatus: 'IN_REVIEW',
          toStatus: 'COMPLETED',
          body: 'Your requested venue update is complete.',
          packageFulfillment: {
            contractVersion: 1,
            linkedPackageCount: 0,
            packages: [],
            digest: 'b'.repeat(64),
          },
        },
        approvalDecisionId: 'decision_completion_1',
      }),
      expect.anything(),
    )
  })

  it('derives exact one-shot package-draft authority without executing the package', async () => {
    const payload = {
      schemaVersion: 3,
      venue: { identity: { name: 'Reviewed venue name' } },
      places: { create: [], update: [], delete: [] },
      knowledgeEntries: { create: [], update: [], delete: [] },
    }
    const operationCounts = {
      venuePatch: true,
      placeCreates: 0,
      placeUpdates: 0,
      placeDeletes: 0,
      knowledgeCreates: 0,
      knowledgeUpdates: 0,
      knowledgeDeletes: 0,
      total: 1,
    }
    mocks.transactionApprovalFindFirst.mockResolvedValue({
      id: 'approval_package_1',
      agentIdentityId: 'agent_1',
      proposedAction: 'pathfinder.apply_support_package_draft',
      scopeSnapshot: {
        contractVersion: 1,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestId: 'request_1',
        expectedVersion: 5,
        fromStatus: 'IN_REVIEW',
        draftKey: '33333333-3333-4333-8333-333333333333',
        payload,
        proposalPayloadHash: 'e5efbd87162cf2f0e6f2cc81a555123bf9f45809d526c64619e6ec68ef6ad29a',
        operationCounts,
        missingInformationCount: 0,
        packageDraftCreated: false,
        packageLinked: false,
        packageApproved: false,
        packageApplied: false,
        packagePublished: false,
        supportRequestChanged: false,
        clientActivityChanged: false,
        customerContacted: false,
        externalDeliveryTriggered: false,
        executionAuthorized: false,
      },
      expiresAt: null,
    })
    mocks.recordDecision.mockResolvedValue({ id: 'decision_package_1', decision: 'APPROVED' })
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_package_1' })
    const result = await testRouter
      .createCaller(context())
      .agentOperations.decideSupportPackageDraftProposal({
        operationId: '60444444-4444-4444-8444-444444444444',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_package_1',
        decision: 'APPROVED',
      })
    expect(result).toMatchObject({
      executionTriggered: false,
      approvalGrant: { id: 'grant_package_1' },
    })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.apply_support_package_draft',
        capability: 'packages:draft',
        mode: 'ONE_SHOT',
        scope: expect.objectContaining({ effect: 'EXACT_SUPPORT_LINKED_V3_DRAFT_ONLY' }),
        parameters: expect.objectContaining({
          clientId: 'tenant_1',
          venueId: 'venue_1',
          requestId: 'request_1',
          expectedVersion: 5,
          draftKey: '33333333-3333-4333-8333-333333333333',
          payload,
          operationCounts,
        }),
        approvalDecisionId: 'decision_package_1',
      }),
      expect.anything(),
    )
  })

  it('issues only exact one-shot DRAFT-to-APPROVED authority for a support-linked package', async () => {
    const expectedUpdatedAt = '2030-01-01T00:00:00.000Z'
    const payloadHash = 'a'.repeat(64)
    const baseDigest = 'b'.repeat(64)
    const warningDigest = 'c'.repeat(64)
    const supportHandoff = {
      handoffId: 'handoff_1',
      supportRequestId: 'request_1',
      supportRequestVersion: 6,
    }
    mocks.transactionApprovalFindFirst.mockResolvedValue({
      id: 'approval_package_approval_1',
      agentIdentityId: 'agent_1',
      proposedAction: 'pathfinder.apply_support_package_approval',
      scopeSnapshot: {
        contractVersion: 1,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        packageId: 'package_1',
        expectedUpdatedAt,
        fromStatus: 'DRAFT',
        toStatus: 'APPROVED',
        payloadHash,
        baseDigest,
        warningDigest,
        warningCodes: [],
        supportHandoff,
        evaluationEvidence: {
          exactPackageRunIds: ['77777777-7777-4777-8777-777777777777'],
          truncated: false,
          thresholdApplied: false,
        },
        packageApproved: false,
        packageApplied: false,
        packagePublished: false,
        supportRequestChanged: false,
        customerContacted: false,
        externalDeliveryTriggered: false,
        executionAuthorized: false,
      },
      expiresAt: null,
    })
    mocks.transactionPackageFindFirst.mockResolvedValue({
      id: 'package_1',
      status: 'DRAFT',
      updatedAt: new Date(expectedUpdatedAt),
      payloadHash,
      baseDigest,
      previewPlan: { warningDigest },
      supportHandoffs: [
        {
          id: supportHandoff.handoffId,
          supportRequestId: supportHandoff.supportRequestId,
          requestVersion: supportHandoff.supportRequestVersion,
        },
      ],
    })
    mocks.recordDecision.mockResolvedValue({ id: 'decision_package_approval_1' })
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_package_approval_1' })
    const result = await testRouter
      .createCaller(context())
      .agentOperations.decideSupportPackageApprovalProposal({
        operationId: '70444444-4444-4444-8444-444444444444',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_package_approval_1',
        decision: 'APPROVED',
      })
    expect(result).toMatchObject({
      executionTriggered: false,
      approvalGrant: { id: 'grant_package_approval_1' },
    })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.apply_support_package_approval',
        capability: 'packages:approve',
        mode: 'ONE_SHOT',
        scope: expect.objectContaining({
          effect: 'EXACT_SUPPORT_LINKED_PACKAGE_DRAFT_TO_APPROVED_ONLY',
        }),
        parameters: {
          clientId: 'tenant_1',
          venueId: 'venue_1',
          packageId: 'package_1',
          expectedUpdatedAt,
          payloadHash,
          baseDigest,
          warningDigest,
          supportHandoff,
        },
        approvalDecisionId: 'decision_package_approval_1',
      }),
      expect.anything(),
    )
  })

  it('issues exact one-shot current-content package authority without executing it', async () => {
    const expectedUpdatedAt = '2030-01-02T00:00:00.000Z'
    const approvedAt = '2030-01-01T00:00:00.000Z'
    const payloadHash = 'a'.repeat(64)
    const baseDigest = 'b'.repeat(64)
    const warningDigest = 'c'.repeat(64)
    const supportHandoff = {
      handoffId: 'handoff_1',
      supportRequestId: 'request_1',
      supportRequestVersion: 6,
    }
    mocks.transactionApprovalFindFirst.mockResolvedValue({
      id: 'approval_package_application_1',
      agentIdentityId: 'agent_1',
      proposedAction: 'pathfinder.apply_support_package_application',
      scopeSnapshot: {
        contractVersion: 1,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        packageId: 'package_1',
        expectedUpdatedAt,
        fromStatus: 'APPROVED',
        toStatus: 'APPLIED',
        payloadHash,
        baseDigest,
        warningDigest,
        warningCodes: [],
        approvedAt,
        approvedBy: 'operator_1',
        supportHandoff,
        evaluationEvidence: {
          exactPackageRunIds: [],
          truncated: false,
          thresholdApplied: false,
        },
        currentContentMutation: true,
        visitorVisibleChangePossible: true,
        supportRequestChanged: false,
        customerContacted: false,
        externalDeliveryTriggered: false,
        supportCompletionTriggered: false,
        revertTriggered: false,
        executionAuthorized: false,
      },
      expiresAt: null,
    })
    mocks.transactionPackageFindFirst.mockResolvedValue({
      status: 'APPROVED',
      updatedAt: new Date(expectedUpdatedAt),
      payloadHash,
      baseDigest,
      approvedAt: new Date(approvedAt),
      approvedBy: 'operator_1',
      previewPlan: { warningDigest },
      supportHandoffs: [
        {
          supportRequestId: supportHandoff.supportRequestId,
          requestVersion: supportHandoff.supportRequestVersion,
        },
      ],
    })
    mocks.recordDecision.mockResolvedValue({ id: 'decision_package_application_1' })
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_package_application_1' })
    const result = await testRouter
      .createCaller(context())
      .agentOperations.decideSupportPackageApplicationProposal({
        operationId: '88888888-8888-4888-8888-888888888888',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_package_application_1',
        decision: 'APPROVED',
      })
    expect(result).toMatchObject({
      executionTriggered: false,
      approvalGrant: { id: 'grant_package_application_1' },
    })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.apply_support_package_application',
        capability: 'packages:apply',
        mode: 'ONE_SHOT',
        scope: expect.objectContaining({
          effect: 'EXACT_APPROVED_SUPPORT_PACKAGE_TO_CURRENT_CONTENT',
          currentContentMutation: true,
          visitorVisibleChangePossible: true,
          supportCompletionIncluded: false,
          customerContactIncluded: false,
          revertIncluded: false,
        }),
        parameters: {
          clientId: 'tenant_1',
          venueId: 'venue_1',
          packageId: 'package_1',
          expectedUpdatedAt,
          payloadHash,
          baseDigest,
          warningDigest,
          approvedAt,
          approvedBy: 'operator_1',
          supportHandoff,
        },
        approvalDecisionId: 'decision_package_application_1',
      }),
      expect.anything(),
    )
  })

  it('issues exact package reversion authority without executing rollback or changing support', async () => {
    const expectedUpdatedAt = '2030-01-02T00:00:00.000Z'
    const appliedAt = '2030-01-01T00:00:00.000Z'
    const appliedEntities = { rollbackContractVersion: 1, schemaVersion: 3, knowledgeEntries: [] }
    const rollbackManifestDigest = supportPackageRollbackManifestDigest(appliedEntities)
    const supportHandoff = {
      handoffId: 'handoff_1',
      supportRequestId: 'request_1',
      supportRequestVersion: 4,
    }
    mocks.transactionApprovalFindFirst.mockResolvedValue({
      id: 'approval_package_reversion_1',
      agentIdentityId: 'agent_1',
      proposedAction: 'pathfinder.apply_support_package_reversion',
      scopeSnapshot: {
        contractVersion: 1,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        packageId: 'package_1',
        expectedUpdatedAt,
        fromStatus: 'APPLIED',
        toStatus: 'REVERTED',
        payloadHash: 'a'.repeat(64),
        baseDigest: 'b'.repeat(64),
        rollbackManifestDigest,
        appliedAt,
        appliedBy: 'agent_application_1',
        appliedCommandKey: '88888888-8888-4888-8888-888888888888',
        supportHandoff,
        supportRequestVersion: 6,
        supportRequestStatus: 'IN_REVIEW',
        currentContentMutation: true,
        visitorVisibleChangePossible: true,
        canonicalDriftCheckRequired: true,
        automaticRollbackPolicyApplied: false,
        supportRequestChanged: false,
        customerContacted: false,
        externalDeliveryTriggered: false,
        executionAuthorized: false,
      },
      expiresAt: null,
    })
    mocks.transactionPackageFindFirst.mockResolvedValue({
      status: 'APPLIED',
      updatedAt: new Date(expectedUpdatedAt),
      payloadHash: 'a'.repeat(64),
      baseDigest: 'b'.repeat(64),
      appliedEntities,
      appliedAt: new Date(appliedAt),
      appliedBy: 'agent_application_1',
      appliedCommandKey: '88888888-8888-4888-8888-888888888888',
      supportHandoffs: [
        {
          supportRequestId: 'request_1',
          requestVersion: 4,
          supportRequest: { version: 6, status: 'IN_REVIEW' },
        },
      ],
    })
    mocks.recordDecision.mockResolvedValue({ id: 'decision_package_reversion_1' })
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_package_reversion_1' })
    const result = await testRouter
      .createCaller(context())
      .agentOperations.decideSupportPackageReversionProposal({
        operationId: '99999999-9999-4999-8999-999999999999',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_package_reversion_1',
        decision: 'APPROVED',
      })
    expect(result).toMatchObject({
      executionTriggered: false,
      approvalGrant: { id: 'grant_package_reversion_1' },
    })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.apply_support_package_reversion',
        capability: 'packages:revert',
        mode: 'ONE_SHOT',
        scope: expect.objectContaining({
          effect: 'EXACT_APPLIED_SUPPORT_PACKAGE_CANONICAL_REVERSION',
          canonicalDriftCheckRequired: true,
          automaticRollbackPolicyIncluded: false,
          supportRequestChangeIncluded: false,
          customerContactIncluded: false,
        }),
        parameters: expect.objectContaining({
          packageId: 'package_1',
          rollbackManifestDigest,
          supportRequestVersion: 6,
          supportRequestStatus: 'IN_REVIEW',
        }),
        approvalDecisionId: 'decision_package_reversion_1',
      }),
      expect.anything(),
    )
  })

  it('issues exact handoff-supersession authority while preserving history and execution separation', async () => {
    const snapshot = {
      contractVersion: 1 as const,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'request_1',
      expectedVersion: 8,
      supportRequestStatus: 'IN_REVIEW' as const,
      superseded: {
        handoffId: 'handoff_old',
        packageId: 'package_old',
        handoffRequestVersion: 4,
        packageUpdatedAt: '2030-01-01T00:00:00.000Z',
        payloadHash: 'a'.repeat(64),
        revertedAt: '2030-01-01T00:00:00.000Z',
        revertedBy: 'agent_old',
        revertedCommandKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      replacement: {
        handoffId: 'handoff_new',
        packageId: 'package_new',
        handoffRequestVersion: 7,
        packageUpdatedAt: '2030-01-02T00:00:00.000Z',
        payloadHash: 'b'.repeat(64),
        appliedAt: '2030-01-02T00:00:00.000Z',
        appliedBy: 'agent_new',
        appliedCommandKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
      historicalHandoffPreserved: true as const,
      replacementAlreadyApplied: true as const,
      packageLifecycleChanged: false as const,
      supportRequestChanged: false as const,
      supportStatusChanged: false as const,
      clientActivityChanged: false as const,
      customerContacted: false as const,
      externalDeliveryTriggered: false as const,
      executionAuthorized: false as const,
    }
    mocks.transactionApprovalFindFirst.mockResolvedValue({
      id: 'approval_supersession_1',
      agentIdentityId: 'agent_1',
      proposedAction: 'pathfinder.apply_support_package_handoff_supersession',
      scopeSnapshot: snapshot,
      expiresAt: null,
    })
    mocks.transactionSupportRequestFindFirst.mockResolvedValue({
      version: 8,
      status: 'IN_REVIEW',
      packageHandoffs: [
        {
          id: 'handoff_old',
          requestVersion: 4,
          supersessionAsPrior: null,
          venuePackage: {
            id: 'package_old',
            status: 'REVERTED',
            updatedAt: new Date(snapshot.superseded.packageUpdatedAt),
            payloadHash: snapshot.superseded.payloadHash,
            appliedAt: new Date('2029-12-31T00:00:00.000Z'),
            appliedBy: 'agent_old',
            appliedCommandKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            revertedAt: new Date(snapshot.superseded.revertedAt),
            revertedBy: snapshot.superseded.revertedBy,
            revertedCommandKey: snapshot.superseded.revertedCommandKey,
          },
        },
        {
          id: 'handoff_new',
          requestVersion: 7,
          supersessionAsPrior: null,
          venuePackage: {
            id: 'package_new',
            status: 'APPLIED',
            updatedAt: new Date(snapshot.replacement.packageUpdatedAt),
            payloadHash: snapshot.replacement.payloadHash,
            appliedAt: new Date(snapshot.replacement.appliedAt),
            appliedBy: snapshot.replacement.appliedBy,
            appliedCommandKey: snapshot.replacement.appliedCommandKey,
            revertedAt: null,
            revertedBy: null,
            revertedCommandKey: null,
          },
        },
      ],
    })
    mocks.recordDecision.mockResolvedValue({ id: 'decision_supersession_1' })
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_supersession_1' })
    const result = await testRouter
      .createCaller(context())
      .agentOperations.decideSupportPackageHandoffSupersessionProposal({
        operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_supersession_1',
        decision: 'APPROVED',
      })
    expect(result).toMatchObject({
      executionTriggered: false,
      approvalGrant: { id: 'grant_supersession_1' },
    })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.apply_support_package_handoff_supersession',
        capability: 'packages:reconcile',
        mode: 'ONE_SHOT',
        scope: expect.objectContaining({
          effect: 'EXACT_SUPPORT_PACKAGE_HANDOFF_CURRENT_TRUTH_SUPERSESSION',
          historicalHandoffPreserved: true,
          packageLifecycleChangeIncluded: false,
          customerContactIncluded: false,
        }),
        parameters: expect.objectContaining({
          requestId: 'request_1',
          expectedVersion: 8,
          superseded: snapshot.superseded,
          replacement: snapshot.replacement,
        }),
        approvalDecisionId: 'decision_supersession_1',
      }),
      expect.anything(),
    )
  })

  it('issues exactly one evidence-backed attachment-free internal support note', async () => {
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_note', replayed: false })
    await testRouter.createCaller(context()).agentOperations.issueSupportInternalNotePolicy({
      operationId: '46444444-4444-4444-8444-444444444444',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentIdentityId: 'agent_1',
      policyKey: 'support-internal-note-once',
      issueReason: 'Reviewed outcomes justify one internal continuity note.',
      outcomeObservationIds: ['outcome_1'],
      maxBodyChars: 4000,
    })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith({
      operationId: '46444444-4444-4444-8444-444444444444',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentIdentityId: 'agent_1',
      actionName: 'pathfinder.add_support_internal_note',
      capability: 'support:note',
      mode: 'POLICY_BACKED',
      policyKey: 'support-internal-note-once',
      scope: {
        contractVersion: 1,
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        effect: 'INTERNAL_NOTE_ONLY',
      },
      constraints: {
        contractVersion: 1,
        effect: 'INTERNAL_NOTE_ONLY',
        allowedVisibilities: ['INTERNAL_ONLY'],
        maxAttachments: 0,
        maxBodyChars: 4000,
      },
      issueReason: 'Reviewed outcomes justify one internal continuity note.',
      outcomeObservationIds: ['outcome_1'],
      maxUses: 1,
      actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
    })
  })

  it('issues bounded internal weekly-report draft generation authority', async () => {
    mocks.issueApprovalGrant.mockResolvedValue({ id: 'grant_report', replayed: false })
    await testRouter.createCaller(context()).agentOperations.issueWeeklyReportDraftPolicy({
      operationId: '64444444-4444-4444-8444-444444444444',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentIdentityId: 'agent_1',
      policyKey: 'weekly-report-draft-generation',
      issueReason: 'Reviewed outcomes support bounded internal report drafting.',
      outcomeObservationIds: ['outcome_1'],
      maxTitleChars: 120,
      maxRangeDays: 8,
      maxUses: 12,
    })
    expect(mocks.issueApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.generate_weekly_report_draft',
        capability: 'reports:draft',
        mode: 'POLICY_BACKED',
        scope: {
          contractVersion: 1,
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          effect: 'DRAFT_GENERATION_ONLY',
        },
        constraints: {
          contractVersion: 1,
          effect: 'DRAFT_GENERATION_ONLY',
          maxTitleChars: 120,
          maxRangeDays: 8,
        },
        outcomeObservationIds: ['outcome_1'],
        maxUses: 12,
        actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
      }),
    )
  })

  it('rejects policy issuance by a non-admin before entering the bypass', async () => {
    await expect(
      testRouter.createCaller(context(false)).agentOperations.issueOperationalUpdateDraftPolicy({
        operationId: '22222222-2222-4222-8222-222222222222',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentIdentityId: 'agent_1',
        policyKey: 'support-operational-update-drafts',
        issueReason: 'Reviewed evidence supports this bounded draft authority.',
        outcomeObservationIds: ['outcome_1'],
        maxTitleChars: 160,
        maxBodyChars: 4000,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.issueApprovalGrant).not.toHaveBeenCalled()
    expect(mocks.bypass).not.toHaveBeenCalled()
  })

  it('lists bounded policy evidence and derives exhausted state honestly', async () => {
    const createdAt = new Date('2026-08-24T12:00:00.000Z')
    mocks.approvalGrantFindMany.mockResolvedValue([
      {
        id: 'grant_1',
        createdAt,
        revokedAt: null,
        expiresAt: null,
        notBefore: new Date('2026-08-24T11:00:00.000Z'),
        maxUses: 2,
        useCount: 2,
      },
    ])
    const result = await testRouter
      .createCaller(context())
      .agentOperations.listAgentApprovalPolicies({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      })
    expect(result.items[0]).toMatchObject({ id: 'grant_1', state: 'EXHAUSTED' })
    expect(mocks.approvalGrantFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          mode: 'POLICY_BACKED',
        }),
        take: 51,
        select: expect.objectContaining({
          authorityEvidence: expect.objectContaining({
            select: expect.objectContaining({
              outcomeObservation: expect.objectContaining({
                select: expect.objectContaining({ id: true, summary: true, verdict: true }),
              }),
            }),
          }),
        }),
      }),
    )
  })

  it('requires tenant scope and applies venue, enabled, pagination, and safe selects', async () => {
    const createdAt = new Date('2026-08-11T12:00:00.000Z')
    mocks.agentIdentityFindMany.mockResolvedValue([
      { id: 'agent_2', createdAt },
      { id: 'agent_1', createdAt: new Date('2026-08-11T11:00:00.000Z') },
    ])

    const result = await testRouter.createCaller(context()).agentOperations.listAgentIdentities({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      enabled: true,
      limit: 1,
    })

    expect(result).toEqual({
      items: [{ id: 'agent_2', createdAt }],
      nextCursor: { createdAt: createdAt.toISOString(), id: 'agent_2' },
    })
    expect(mocks.agentIdentityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', venueId: 'venue_1', enabled: true },
        take: 2,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: expect.not.objectContaining({
          runs: expect.anything(),
          actions: expect.anything(),
        }),
      }),
    )
  })

  it('uses tenant-bound keyset pagination for a run timeline without exposing raw data', async () => {
    mocks.agentTimelineEventFindMany.mockResolvedValue([])
    await testRouter.createCaller(context()).agentOperations.listAgentRunTimeline({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentRunId: 'run_1',
      agentActionId: 'action_1',
      cursor: { createdAt: '2026-08-11T12:00:00.000Z', id: 'event_2' },
      limit: 20,
    })

    const call = mocks.agentTimelineEventFindMany.mock.calls[0]?.[0]
    expect(call.where).toEqual({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentRunId: 'run_1',
      agentActionId: 'action_1',
      AND: [
        {
          OR: [
            { createdAt: { lt: new Date('2026-08-11T12:00:00.000Z') } },
            {
              createdAt: new Date('2026-08-11T12:00:00.000Z'),
              id: { lt: 'event_2' },
            },
          ],
        },
      ],
    })
    expect(call.select.data).toBeUndefined()
    expect(call.take).toBe(21)
  })

  it('lists only unexpired undecided approvals by default and reports pending state', async () => {
    const createdAt = new Date('2026-08-11T12:00:00.000Z')
    mocks.approvalRequestFindMany.mockResolvedValue([
      { id: 'approval_1', createdAt, expiresAt: null, decision: null },
    ])

    const result = await testRouter
      .createCaller(context())
      .agentOperations.listApprovalRequests({ tenantId: 'tenant_1' })

    expect(result.items[0]).toMatchObject({ id: 'approval_1', state: 'PENDING' })
    expect(mocks.approvalRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          decision: { is: null },
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
        take: 51,
        select: expect.objectContaining({
          customerAccessRequest: {
            select: expect.objectContaining({
              targetEmail: true,
              requestedRole: true,
              status: true,
              sourceSupportMessageId: true,
            }),
          },
        }),
      }),
    )
  })

  it('distinguishes implicit expiry and persisted decisions on approval detail', async () => {
    const base = {
      id: 'approval_1',
      createdAt: new Date('2026-08-10T12:00:00.000Z'),
      expiresAt: new Date('2026-08-10T13:00:00.000Z'),
    }
    mocks.approvalRequestFindFirst.mockResolvedValueOnce({ ...base, decision: null })
    const expired = await testRouter.createCaller(context()).agentOperations.getApprovalRequest({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      approvalRequestId: 'approval_1',
    })
    expect(expired.state).toBe('EXPIRED')
    expect(mocks.approvalRequestFindFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'approval_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      }),
    )

    mocks.approvalRequestFindFirst.mockResolvedValueOnce({
      ...base,
      decision: { decision: 'APPROVED' },
    })
    const approved = await testRouter.createCaller(context()).agentOperations.getApprovalRequest({
      tenantId: 'tenant_1',
      approvalRequestId: 'approval_1',
    })
    expect(approved.state).toBe('APPROVED')
  })

  it('returns a scoped not-found error rather than leaking an out-of-scope run', async () => {
    mocks.agentRunFindFirst.mockResolvedValue(null)
    await expect(
      testRouter.createCaller(context()).agentOperations.getAgentRun({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentRunId: 'run_other_tenant',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Agent run not found' })
    expect(mocks.agentRunFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run_other_tenant', tenantId: 'tenant_1', venueId: 'venue_1' },
      }),
    )
  })

  it('records a human platform-admin decision without claiming execution', async () => {
    mocks.recordDecision.mockResolvedValue({ id: 'decision_1', decision: 'APPROVED' })
    const result = await testRouter.createCaller(context()).agentOperations.recordApprovalDecision({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      approvalRequestId: 'approval_1',
      decision: 'APPROVED',
      reason: 'Reviewed evidence',
    })
    expect(mocks.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_1',
        decision: 'APPROVED',
        actor: { actorType: 'HUMAN', actorId: 'operator_1', auditRole: 'PLATFORM_ADMIN' },
      }),
      expect.anything(),
    )
    expect(result).toEqual({
      decision: { id: 'decision_1', decision: 'APPROVED' },
      executionTriggered: false,
    })
  })

  it('rejects decision recording by a non-admin before the bypass or domain action', async () => {
    await expect(
      testRouter.createCaller(context(false)).agentOperations.recordApprovalDecision({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_1',
        decision: 'REJECTED',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.recordDecision).not.toHaveBeenCalled()
  })
})
