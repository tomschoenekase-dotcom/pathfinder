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
  recordDecision: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  ApprovalDecisionActionError: class ApprovalDecisionActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  recordApprovalDecisionAction: mocks.recordDecision,
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
  },
}))

import { mergeRouters, router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminAgentApprovalDecisionsRouter } from './agent-approval-decisions'
import { adminAgentOperationsRouter } from './agent-operations'

const testRouter = router({
  agentOperations: mergeRouters(adminAgentOperationsRouter, adminAgentApprovalDecisionsRouter),
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
