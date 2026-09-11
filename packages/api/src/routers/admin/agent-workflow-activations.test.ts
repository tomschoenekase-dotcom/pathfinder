import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  bypass: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  request: vi.fn(),
  transitionRequest: vi.fn(),
  apply: vi.fn(),
  transition: vi.fn(),
  heads: vi.fn(),
  head: vi.fn(),
  versions: vi.fn(),
  events: vi.fn(),
  tools: vi.fn(() => [{ _meta: { 'com.pathfinder/security': { capability: 'support:write' } } }]),
}))
vi.mock('@pathfinder/db', () => ({
  AgentWorkflowActivationError: class AgentWorkflowActivationError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  AgentWorkflowPromotionAssessmentError: class AgentWorkflowPromotionAssessmentError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  isVenueUnavailableError: (error: unknown) =>
    error instanceof Error && error.name === 'VenueUnavailableError',
  assertVenueAvailable: mocks.available,
  withTenantIsolationBypass: mocks.bypass,
  requestAgentWorkflowActivationApproval: mocks.request,
  requestAgentWorkflowTransitionApproval: mocks.transitionRequest,
  activateAgentWorkflowVersion: mocks.apply,
  transitionAgentWorkflowActivation: mocks.transition,
  db: {
    agentWorkflowActivationHead: { findMany: mocks.heads, findFirst: mocks.head },
    agentWorkflowActivationEvent: { findMany: mocks.events },
    agentWorkflowVersion: { findMany: mocks.versions },
  },
}))
vi.mock('../../mcp/composition', () => ({
  createSafeOperationalMcpRegistry: () => ({ listTools: mocks.tools }),
}))
import { AgentWorkflowActivationError, AgentWorkflowPromotionAssessmentError } from '@pathfinder/db'
import type { TRPCContext } from '../../context'
import { adminAgentWorkflowActivationsRouter } from './agent-workflow-activations'

const scope = { tenantId: 'tenant-one', venueId: 'venue-one' }
const common = {
  ...scope,
  operationId: '11111111-1111-4111-8111-111111111111',
  registryKey: 'grounded-review',
  expectedHeadRevision: 0,
  reason: 'Review a bounded canary.',
}
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
const activation = {
  ...common,
  workflowVersionId: '22222222-2222-4222-8222-222222222222',
  promotionAssessmentId: 'assessment-one',
  canaryPolicy: policy,
}
function caller(admin = true) {
  return adminAgentWorkflowActivationsRouter.createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator-one',
      activeTenantId: 'different-tenant',
      role: 'STAFF',
      isPlatformAdmin: admin,
    },
  } as TRPCContext)
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.available.mockReset().mockResolvedValue(undefined)
  mocks.request.mockReset().mockResolvedValue({ request: { id: 'approval-one' }, replayed: false })
  mocks.transitionRequest
    .mockReset()
    .mockResolvedValue({ request: { id: 'approval-two' }, replayed: false })
  mocks.apply.mockReset().mockResolvedValue({ event: { id: 'event-one' }, replayed: false })
  mocks.transition.mockReset().mockResolvedValue({ event: { id: 'event-two' }, replayed: false })
  mocks.heads.mockReset().mockResolvedValue([])
  mocks.head.mockReset().mockResolvedValue(null)
  mocks.versions.mockReset().mockResolvedValue([])
  mocks.events.mockReset().mockResolvedValue([])
})

describe('operator workflow activation boundary', () => {
  it('rejects non-admin requests and reads before scoped database access', async () => {
    await expect(
      caller(false).requestAgentWorkflowActivationApproval({
        ...activation,
        agentIdentityId: 'agent-one',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller(false).listAgentWorkflowActivations(scope)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(mocks.available).not.toHaveBeenCalled()
    expect(mocks.bypass).not.toHaveBeenCalled()
  })
  it('requests approval with auth actor and server capabilities without applying', async () => {
    const result = await caller().requestAgentWorkflowActivationApproval({
      ...activation,
      agentIdentityId: 'agent-one',
    })
    expect(result).toEqual({ request: { id: 'approval-one' }, replayed: false })
    const { operationId, ...rest } = activation
    expect(mocks.request).toHaveBeenCalledWith(
      {
        ...rest,
        agentIdentityId: 'agent-one',
        requestOperationId: operationId,
        actor: { type: 'HUMAN', id: 'operator-one', role: 'PLATFORM_ADMIN' },
      },
      new Set(['support:write']),
    )
    expect(mocks.request.mock.calls[0]?.[0]).not.toHaveProperty('operationId')
    expect(mocks.available).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(scope))
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.transition).not.toHaveBeenCalled()
  })
  it('rejects caller authority fields and unavailable venues before request creation', async () => {
    await expect(
      caller().requestAgentWorkflowActivationApproval({
        ...activation,
        agentIdentityId: 'agent-one',
        actor: { id: 'forged' },
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const unavailable = new Error('private venue failure')
    unavailable.name = 'VenueUnavailableError'
    mocks.available.mockRejectedValueOnce(unavailable)
    await expect(
      caller().requestAgentWorkflowActivationApproval({
        ...activation,
        agentIdentityId: 'agent-one',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Venue is unavailable' })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.bypass).not.toHaveBeenCalled()
  })
  it('passes the exact decision to explicit activation with auth-derived actor', async () => {
    await caller().applyAgentWorkflowActivation({
      ...activation,
      approvalDecisionId: 'decision-one',
    })
    expect(mocks.apply).toHaveBeenCalledWith(
      {
        ...activation,
        approvalDecisionId: 'decision-one',
        actor: { type: 'HUMAN', id: 'operator-one', role: 'PLATFORM_ADMIN' },
      },
      new Set(['support:write']),
    )
  })
  it('keeps transition request distinct from execution and strips operation alias', async () => {
    const input = {
      ...common,
      expectedHeadRevision: 1,
      kind: 'REVOKE' as const,
      agentIdentityId: 'agent-one',
    }
    await caller().requestAgentWorkflowTransitionApproval(input)
    expect(mocks.transitionRequest.mock.calls[0]?.[0]).toMatchObject({
      requestOperationId: common.operationId,
      kind: 'REVOKE',
      actor: { id: 'operator-one' },
    })
    expect(mocks.transitionRequest.mock.calls[0]?.[0]).not.toHaveProperty('operationId')
    expect(mocks.transition).not.toHaveBeenCalled()
    await caller().applyAgentWorkflowTransition({
      ...common,
      expectedHeadRevision: 1,
      kind: 'REVOKE',
      approvalDecisionId: 'decision-two',
    })
    expect(mocks.transition.mock.calls[0]?.[0]).toMatchObject({
      approvalDecisionId: 'decision-two',
      actor: { id: 'operator-one' },
    })
  })
  it.each(['FORBIDDEN', 'CONFLICT', 'NOT_FOUND', 'INVALID_INPUT'] as const)(
    'maps canonical %s by code rather than error wording',
    async (code) => {
      mocks.apply.mockRejectedValueOnce(
        new AgentWorkflowActivationError(code, 'A neutral explanation'),
      )
      await expect(
        caller().applyAgentWorkflowActivation({
          ...activation,
          approvalDecisionId: 'decision-one',
        }),
      ).rejects.toMatchObject({ code: code === 'INVALID_INPUT' ? 'BAD_REQUEST' : code })
    },
  )
  it('does not expose unexpected backend error details', async () => {
    mocks.apply.mockRejectedValueOnce(new Error('private backend connection detail'))
    await expect(
      caller().applyAgentWorkflowActivation({ ...activation, approvalDecisionId: 'decision-one' }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Workflow activation could not be completed',
    })
  })
  it('preserves canonical stale-assessment conflict semantics', async () => {
    mocks.apply.mockRejectedValueOnce(
      new AgentWorkflowPromotionAssessmentError('CONFLICT', 'Evaluation evidence changed'),
    )
    await expect(
      caller().applyAgentWorkflowActivation({ ...activation, approvalDecisionId: 'decision-one' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Evaluation evidence changed' })
  })
  it('paginates scoped immutable events and heads without portable workflow bodies', async () => {
    const createdAt = new Date('2026-09-07T12:00:00Z')
    const id = '33333333-3333-4333-8333-333333333333'
    mocks.heads.mockResolvedValueOnce([{ registryKey: 'beta' }, { registryKey: 'gamma' }])
    mocks.events.mockResolvedValueOnce([
      { id, createdAt },
      { id: '44444444-4444-4444-8444-444444444444', createdAt },
    ])
    const result = await caller().listAgentWorkflowActivations({
      ...scope,
      limit: 1,
      headAfterRegistryKey: 'alpha',
      eventBefore: { id, createdAt: createdAt.toISOString() },
    })
    expect(result.heads).toHaveLength(1)
    expect(result.events).toHaveLength(1)
    expect(result.nextHeadAfterRegistryKey).toBe('beta')
    expect(result.nextEventBefore).toEqual({ id, createdAt: createdAt.toISOString() })
    expect(mocks.heads.mock.calls[0]?.[0]).toMatchObject({
      where: { ...scope, AND: [{ registryKey: { gt: 'alpha' } }] },
      take: 2,
    })
    expect(mocks.events.mock.calls[0]?.[0]).toMatchObject({
      where: { ...scope, OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] },
      take: 2,
    })
    expect(JSON.stringify(mocks.heads.mock.calls[0]?.[0].select)).not.toContain('portableText')
    expect(JSON.stringify(mocks.events.mock.calls[0]?.[0].select)).not.toContain('scopeSnapshot')
    await expect(
      caller().listAgentWorkflowActivations({ ...scope, limit: 51 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('composes exact scoped rollback targets with independent keyset pagination', async () => {
    const activeId = '22222222-2222-4222-8222-222222222222'
    const targetId = '33333333-3333-4333-8333-333333333333'
    const extraId = '44444444-4444-4444-8444-444444444444'
    const createdAt = new Date('2026-09-08T12:00:00Z')
    mocks.head.mockResolvedValueOnce({
      registryKey: common.registryKey,
      revision: 4,
      selectedRunCount: 3,
      activeVersionId: activeId,
      activeVersion: {
        id: activeId,
        version: 4,
        contentHash: 'a'.repeat(64),
        requiredToolCapabilities: ['support:write'],
      },
      activationEvent: {
        id: '55555555-5555-4555-8555-555555555555',
        kind: 'ACTIVATE',
        eventHash: 'b'.repeat(64),
        resultingRevision: 4,
        createdAt,
      },
    })
    const target = {
      id: targetId,
      version: 3,
      kind: 'WORKFLOW',
      manifestHash: 'c'.repeat(64),
      contentHash: 'd'.repeat(64),
      requiredToolCapabilities: ['support:write', 'missing:tool'],
      resultingActivationEvents: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          kind: 'ACTIVATE',
          resultingRevision: 3,
          eventHash: 'e'.repeat(64),
          createdAt,
        },
      ],
    }
    mocks.versions.mockResolvedValueOnce([target, { ...target, id: extraId, version: 2 }])
    const result = await caller().getAgentWorkflowTransitionComposer({
      ...scope,
      registryKey: common.registryKey,
      targetBefore: { version: 5, id: '77777777-7777-4777-8777-777777777777' },
      limit: 1,
    })
    expect(result).toMatchObject({
      head: {
        expectedHeadRevision: 4,
        revokeEligible: true,
        availablePriorBaseline: { workflowVersionId: activeId, contentHash: 'a'.repeat(64) },
      },
      rollbackTargets: [
        {
          workflowVersionId: targetId,
          artifactIntegrity: 'NOT_CHECKED_BODY_ON_REQUEST',
          compatibility: { status: 'MISSING_TOOLS', missingCapabilities: ['missing:tool'] },
          eligible: false,
        },
      ],
      nextTargetBefore: { version: 3, id: targetId },
    })
    expect(mocks.versions.mock.calls[0]![0]).toMatchObject({
      where: {
        ...scope,
        registryKey: common.registryKey,
        id: { not: activeId },
        resultingActivationEvents: {
          some: {
            ...scope,
            registryKey: common.registryKey,
            kind: { in: ['ACTIVATE', 'ROLLBACK'] },
          },
        },
        OR: [{ version: { lt: 5 } }, { version: 5, id: { lt: expect.any(String) } }],
      },
      orderBy: [{ version: 'desc' }, { id: 'desc' }],
      take: 2,
    })
    const projection = JSON.stringify(mocks.versions.mock.calls[0]![0].select)
    expect(projection).not.toMatch(/portableText|manifest"|provenance|createdBy|approvalDecision/u)
    expect(mocks.versions.mock.calls[0]![0].select.resultingActivationEvents.where).toEqual({
      ...scope,
      registryKey: common.registryKey,
      kind: { in: ['ACTIVATE', 'ROLLBACK'] },
    })
  })

  it('returns explicit no-head and revoked-head composer states without inventing authority', async () => {
    await expect(
      caller().getAgentWorkflowTransitionComposer({ ...scope, registryKey: 'unknown' }),
    ).resolves.toEqual({ head: null, rollbackTargets: [], nextTargetBefore: null })
    expect(mocks.versions).not.toHaveBeenCalled()

    mocks.head.mockResolvedValueOnce({
      registryKey: common.registryKey,
      revision: 5,
      selectedRunCount: 0,
      activeVersionId: null,
      activeVersion: null,
      activationEvent: null,
    })
    mocks.versions.mockResolvedValueOnce([
      {
        id: '88888888-8888-4888-8888-888888888888',
        version: 2,
        kind: 'WORKFLOW',
        manifestHash: '1'.repeat(64),
        contentHash: '2'.repeat(64),
        requiredToolCapabilities: ['support:write'],
        resultingActivationEvents: [
          {
            id: '99999999-9999-4999-8999-999999999999',
            kind: 'ROLLBACK',
            resultingRevision: 2,
            eventHash: '3'.repeat(64),
            createdAt: new Date('2026-09-08T12:00:00Z'),
          },
        ],
      },
    ])
    const revoked = await caller().getAgentWorkflowTransitionComposer({
      ...scope,
      registryKey: common.registryKey,
    })
    expect(revoked.head).toMatchObject({
      expectedHeadRevision: 5,
      activeVersion: null,
      revokeEligible: false,
      availablePriorBaseline: null,
    })
    expect(revoked.rollbackTargets).toEqual([
      expect.objectContaining({
        version: 2,
        eligible: true,
        compatibility: { status: 'CURRENTLY_AVAILABLE', missingCapabilities: [] },
      }),
    ])
    expect(revoked.nextTargetBefore).toBeNull()
  })

  it('rejects non-admin and unavailable-venue composer reads before projections', async () => {
    await expect(
      caller(false).getAgentWorkflowTransitionComposer({
        ...scope,
        registryKey: common.registryKey,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    mocks.available.mockRejectedValueOnce(
      Object.assign(new Error('private'), { name: 'VenueUnavailableError' }),
    )
    await expect(
      caller().getAgentWorkflowTransitionComposer({ ...scope, registryKey: common.registryKey }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.head).not.toHaveBeenCalled()
    expect(mocks.versions).not.toHaveBeenCalled()
  })

  it('rejects unbounded, malformed, or authority-bearing composer input', async () => {
    await expect(
      caller().getAgentWorkflowTransitionComposer({
        ...scope,
        registryKey: common.registryKey,
        limit: 21,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller().getAgentWorkflowTransitionComposer({
        ...scope,
        registryKey: common.registryKey,
        targetBefore: { version: 0, id: 'not-a-uuid' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller().getAgentWorkflowTransitionComposer({
        ...scope,
        registryKey: common.registryKey,
        approvalDecisionId: 'forged',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.available).not.toHaveBeenCalled()
    expect(mocks.head).not.toHaveBeenCalled()
  })
})
