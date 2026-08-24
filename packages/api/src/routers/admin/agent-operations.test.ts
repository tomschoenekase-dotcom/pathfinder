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
  issueApprovalGrant: vi.fn(),
  revokeApprovalGrant: vi.fn(),
  recordDecision: vi.fn(),
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
  createDisabledAgentIdentity: mocks.createIdentity,
  editDisabledAgentIdentity: mocks.editIdentity,
  disableAgentIdentity: mocks.disableIdentity,
  enableAgentIdentity: mocks.enableIdentity,
  withTenantIsolationBypass: mocks.bypass,
  db: {
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

const testRouter = router({
  agentOperations: mergeRouters(
    adminAgentOperationsRouter,
    adminAgentIdentityConfigurationRouter,
    adminAgentApprovalDecisionsRouter,
    adminAgentRunCancellationRouter,
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
  beforeEach(() => vi.clearAllMocks())

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
