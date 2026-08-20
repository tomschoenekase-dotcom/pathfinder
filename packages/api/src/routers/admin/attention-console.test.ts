import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  jobs: vi.fn(),
  evaluations: vi.fn(),
  approvals: vi.fn(),
  support: vi.fn(),
  agents: vi.fn(),
  questions: vi.fn(),
  outcomes: vi.fn(),
  events: vi.fn(),
  updateEvent: vi.fn(),
  platformEvents: vi.fn(),
  updatePlatformEvent: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: mocks.bypass,
  db: {
    jobRecord: { findMany: mocks.jobs },
    evalRun: { findMany: mocks.evaluations },
    approvalRequest: { findMany: mocks.approvals },
    supportRequest: { findMany: mocks.support },
    agentRun: { findMany: mocks.agents },
    agentQuestion: { findMany: mocks.questions },
    agentOutcomeObservation: { findMany: mocks.outcomes },
    operationalEvent: { findMany: mocks.events, updateMany: mocks.updateEvent },
    platformOperationalEvent: {
      findMany: mocks.platformEvents,
      updateMany: mocks.updatePlatformEvent,
    },
  },
}))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminAttentionConsoleRouter } from './attention-console'

const testRouter = router({ admin: adminAttentionConsoleRouter })

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

describe('admin attention console', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.jobs.mockResolvedValue([])
    mocks.evaluations.mockResolvedValue([])
    mocks.approvals.mockResolvedValue([])
    mocks.support.mockResolvedValue([])
    mocks.agents.mockResolvedValue([])
    mocks.questions.mockResolvedValue([])
    mocks.outcomes.mockResolvedValue([])
    mocks.events.mockResolvedValue([])
    mocks.updateEvent.mockResolvedValue({ count: 1 })
    mocks.platformEvents.mockResolvedValue([])
    mocks.updatePlatformEvent.mockResolvedValue({ count: 1 })
  })

  it('rejects non-admin callers before entering the global bypass', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.attentionConsole({ limit: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
  })

  it('uses bounded explicit safe selects for every attention domain', async () => {
    await testRouter.createCaller(context()).admin.attentionConsole({ limit: 7 })

    for (const query of [
      mocks.jobs,
      mocks.evaluations,
      mocks.approvals,
      mocks.support,
      mocks.agents,
      mocks.questions,
      mocks.outcomes,
      mocks.events,
      mocks.platformEvents,
    ]) {
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({ take: 8, select: expect.any(Object) }),
      )
    }
    const calls = JSON.stringify([
      mocks.jobs.mock.calls[0]![0],
      mocks.evaluations.mock.calls[0]![0],
      mocks.approvals.mock.calls[0]![0],
      mocks.support.mock.calls[0]![0],
      mocks.agents.mock.calls[0]![0],
      mocks.questions.mock.calls[0]![0],
      mocks.outcomes.mock.calls[0]![0],
      mocks.events.mock.calls[0]![0],
      mocks.platformEvents.mock.calls[0]![0],
    ])
    for (const forbidden of [
      'payload',
      'caseSnapshot',
      'modelSnapshot',
      'scopeSnapshot',
      'artifacts',
      'messages',
    ]) {
      expect(calls).not.toContain(forbidden)
    }
    expect(mocks.support.mock.calls[0]![0].where.status.in).toEqual([
      'OPEN',
      'IN_REVIEW',
      'WAITING_FOR_CLIENT',
      'PATCH_DRAFTED',
      'VALIDATING',
      'AWAITING_APPROVAL',
      'APPLYING',
    ])
    expect(mocks.agents).toHaveBeenCalledTimes(4)
    expect(mocks.agents.mock.calls[1]![0].where.status.in).toEqual(['QUEUED', 'RUNNING'])
    expect(mocks.agents.mock.calls[2]![0].where.status.in).toEqual([
      'AWAITING_INPUT',
      'AWAITING_APPROVAL',
      'FAILED',
    ])
    expect(mocks.agents.mock.calls[3]![0].where.status).toBe('COMPLETED')
    expect(mocks.questions.mock.calls[0]![0].where.status).toBe('PENDING')
  })

  it('classifies expired leases and approvals and emits deterministic cursors', async () => {
    const old = new Date('2026-08-10T12:00:00.000Z')
    mocks.evaluations.mockResolvedValue([
      {
        id: 'eval_2',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'RUNNING',
        attemptNumber: 1,
        maxAttempts: 3,
        executionLeaseExpiresAt: old,
        lastErrorCode: null,
        createdAt: old,
      },
      {
        id: 'eval_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'FAILED',
        attemptNumber: 3,
        maxAttempts: 3,
        executionLeaseExpiresAt: null,
        lastErrorCode: 'TIMEOUT',
        createdAt: new Date('2026-08-09T12:00:00.000Z'),
      },
    ])
    mocks.approvals.mockResolvedValue([
      {
        id: 'approval_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        proposedAction: 'Publish',
        riskCategory: 'HIGH',
        expiresAt: old,
        createdAt: old,
        agentIdentity: { name: 'Operator agent' },
      },
    ])

    const result = await testRouter.createCaller(context()).admin.attentionConsole({ limit: 1 })
    expect(result.evaluations.items[0]).toMatchObject({ id: 'eval_2', expiredLease: true })
    expect(result.evaluations.nextCursor).toEqual({ createdAt: old.toISOString(), id: 'eval_2' })
    expect(result.approvals.items[0]).toMatchObject({ id: 'approval_1', expired: true })
  })

  it('acknowledges and resolves only active event states with the operator identity', async () => {
    const caller = testRouter.createCaller(context())
    await expect(
      caller.admin.acknowledgeOperationalEvent({
        eventId: '11111111-1111-4111-8111-111111111111',
      }),
    ).resolves.toEqual({ acknowledged: true })
    expect(mocks.updateEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ state: 'OPEN' }),
        data: expect.objectContaining({ state: 'ACKNOWLEDGED', acknowledgedBy: 'operator_1' }),
      }),
    )

    await expect(
      caller.admin.resolveOperationalEvent({
        eventId: '11111111-1111-4111-8111-111111111111',
      }),
    ).resolves.toEqual({ resolved: true })
    expect(mocks.updateEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ state: { in: ['OPEN', 'ACKNOWLEDGED'] } }),
        data: expect.objectContaining({ state: 'RESOLVED', resolvedBy: 'operator_1' }),
      }),
    )
  })

  it('updates platform CRM attention without touching a tenant event', async () => {
    const caller = testRouter.createCaller(context())
    await expect(
      caller.admin.acknowledgeOperationalEvent({
        eventId: '11111111-1111-4111-8111-111111111111',
        scope: 'platform',
      }),
    ).resolves.toEqual({ acknowledged: true })
    expect(mocks.updatePlatformEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ state: 'OPEN' }),
        data: expect.objectContaining({ acknowledgedBy: 'operator_1' }),
      }),
    )
    expect(mocks.updateEvent).not.toHaveBeenCalled()
  })
})
