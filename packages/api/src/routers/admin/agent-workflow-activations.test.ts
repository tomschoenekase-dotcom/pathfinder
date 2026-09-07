import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  bypass: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  request: vi.fn(),
  transitionRequest: vi.fn(),
  apply: vi.fn(),
  transition: vi.fn(),
  heads: vi.fn(),
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
    agentWorkflowActivationHead: { findMany: mocks.heads },
    agentWorkflowActivationEvent: { findMany: mocks.events },
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
})
