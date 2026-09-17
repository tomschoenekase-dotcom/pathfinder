import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  sessionFindMany: vi.fn(),
  venueFindMany: vi.fn(),
  revoke: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  AgentBridgeActionError: class AgentBridgeActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  revokeAgentBridgeSessionAction: mocks.revoke,
  withTenantIsolationBypass: mocks.bypass,
  db: {
    agentBridgeSession: { findMany: mocks.sessionFindMany },
    venue: { findMany: mocks.venueFindMany },
  },
}))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminAgentBridgeOperationsRouter } from './agent-bridge-operations'

const testRouter = router({ agentBridge: adminAgentBridgeOperationsRouter })

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

describe('admin agent bridge operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sessionFindMany.mockResolvedValue([])
    mocks.venueFindMany.mockResolvedValue([])
  })

  it('lists bounded platform provider presence and active venue setup targets', async () => {
    const sessions = [{ id: 'session_1', provider: 'CODEX_SUBSCRIPTION' }]
    const venues = [{ id: 'venue_1', tenantId: 'tenant_1', name: 'Space Museum' }]
    mocks.sessionFindMany.mockResolvedValue(sessions)
    mocks.venueFindMany.mockResolvedValue(venues)

    await expect(
      testRouter.createCaller(context()).agentBridge.getFounderProviderConnections(),
    ).resolves.toEqual({ sessions, venues })

    expect(mocks.sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
        select: expect.objectContaining({
          provider: true,
          tenant: { select: { name: true } },
          venue: { select: { name: true } },
        }),
      }),
    )
    expect(mocks.venueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true },
        take: 50,
        select: expect.not.objectContaining({ config: expect.anything() }),
      }),
    )
  })

  it('rejects non-admin reads before entering the isolation bypass', async () => {
    await expect(
      testRouter.createCaller(context(false)).agentBridge.getFounderProviderConnections(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.sessionFindMany).not.toHaveBeenCalled()
  })
})
