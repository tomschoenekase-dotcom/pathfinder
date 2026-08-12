import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  link: vi.fn(),
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  requestFindFirst: vi.fn(),
  lineageFindMany: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  SupportAgentRunLineageError: class SupportAgentRunLineageError extends Error {},
  linkSupportRequestAgentRunAction: mocks.link,
  withTenantIsolationBypass: mocks.bypass,
  db: {
    supportRequest: { findFirst: mocks.requestFindFirst },
    supportAgentRunLineage: { findMany: mocks.lineageFindMany },
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminSupportAgentRunLineageRouter } from './support-agent-run-lineage'

const testRouter = router({ admin: adminSupportAgentRunLineageRouter })
const context = (isPlatformAdmin = true): TRPCContext => ({
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: {
    userId: 'admin_1',
    activeTenantId: 'tenant_other',
    role: 'STAFF',
    isPlatformAdmin,
  },
})

describe('admin Support AgentRun lineage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requestFindFirst.mockResolvedValue({ id: 'request_1' })
    mocks.lineageFindMany.mockResolvedValue([])
  })

  it('rejects non-admin callers before action or bypass', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.listSupportAgentRunLineages({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestId: 'request_1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
  })

  it('adapts an exact HUMAN platform-admin link without tenant impersonation', async () => {
    mocks.link.mockResolvedValue({ requestVersion: 4, replayed: false })
    await testRouter.createCaller(context()).admin.linkSupportAgentRun({
      operationId: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'request_1',
      agentRunId: 'run_1',
      expectedVersion: 4,
    })
    expect(mocks.link).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        actor: {
          actorType: 'HUMAN',
          actorId: 'admin_1',
          auditRole: 'PLATFORM_ADMIN',
        },
      }),
      expect.anything(),
    )
  })

  it('checks exact request scope before returning a bounded safe lineage projection', async () => {
    mocks.lineageFindMany.mockResolvedValue([
      {
        id: 'lineage_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        supportRequestId: 'request_1',
        requestVersion: 4,
        agentRunId: 'run_1',
        linkedRunStatus: 'COMPLETED',
        linkedRunCompletedAt: new Date('2026-08-12T12:00:00.000Z'),
        linkedByKind: 'OPERATOR',
        linkedById: 'admin_1',
        linkedByRole: 'PLATFORM_ADMIN',
        createdAt: new Date('2026-08-12T12:01:00.000Z'),
        agentRun: {
          id: 'run_1',
          runType: 'SUPPORT',
          requestedOperation: 'answer-request',
          agentIdentityId: 'agent_1',
          createdAt: new Date('2026-08-12T11:00:00.000Z'),
          completedAt: new Date('2026-08-12T12:00:00.000Z'),
        },
      },
    ])
    const result = await testRouter.createCaller(context()).admin.listSupportAgentRunLineages({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'request_1',
      limit: 10,
    })
    expect(mocks.requestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'request_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      }),
    )
    expect(mocks.lineageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 11,
        select: expect.not.objectContaining({ operationHash: true }),
      }),
    )
    expect(result.items[0]).not.toHaveProperty('operationHash')
  })
})
