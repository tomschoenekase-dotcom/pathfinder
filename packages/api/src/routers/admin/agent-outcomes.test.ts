import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  findMany: vi.fn(),
  record: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  AgentOutcomeActionError: class AgentOutcomeActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  recordAgentOutcomeAction: mocks.record,
  withTenantIsolationBypass: mocks.bypass,
  db: { agentOutcomeObservation: { findMany: mocks.findMany } },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminAgentOutcomesRouter } from './agent-outcomes'

const testRouter = router({ admin: adminAgentOutcomesRouter })

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator-1',
      activeTenantId: 'tenant-other',
      role: 'STAFF',
      isPlatformAdmin,
    },
  }
}

describe('admin agent outcomes router', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects non-admin writes before bypassing tenant isolation', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.recordAgentRunOutcome({
        operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentRunId: 'run-1',
        verdict: 'POSITIVE',
        summary: 'Useful result.',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })

  it('records a human review with session-derived authority', async () => {
    mocks.record.mockResolvedValue({ id: 'outcome-1', replayed: false })
    const result = await testRouter.createCaller(context()).admin.recordAgentRunOutcome({
      operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentRunId: 'run-1',
      verdict: 'MIXED',
      summary: ' Useful after one correction. ',
      evidenceRef: ' decision-42 ',
    })

    expect(result).toEqual({ id: 'outcome-1', replayed: false })
    expect(mocks.record).toHaveBeenCalledWith(
      {
        operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentRunId: 'run-1',
        verdict: 'MIXED',
        summary: 'Useful after one correction.',
        evidenceRef: 'decision-42',
        actor: { type: 'HUMAN', id: 'operator-1', role: 'PLATFORM_ADMIN' },
      },
      expect.anything(),
    )
  })

  it('lists only the requested tenant, venue, run, identity, and signal scope', async () => {
    mocks.findMany.mockResolvedValue([])
    const result = await testRouter.createCaller(context()).admin.listAgentOutcomeObservations({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentRunId: 'run-1',
      agentIdentityId: 'agent-1',
      signalKind: 'HUMAN_REVIEW',
      limit: 25,
    })

    expect(result).toEqual({ items: [], nextCursor: null })
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          agentRunId: 'run-1',
          agentIdentityId: 'agent-1',
          signalKind: 'HUMAN_REVIEW',
        }),
        take: 26,
      }),
    )
  })
})
