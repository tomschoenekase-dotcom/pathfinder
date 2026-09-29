import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const upsert = vi.fn(
    async ({
      create,
      update,
    }: {
      create: Record<string, unknown>
      update: Record<string, unknown>
    }) => ({
      websiteState: (update.websiteState ?? create.websiteState ?? 'DISABLED') as string,
      appState: (update.appState ?? create.appState ?? 'DISABLED') as string,
      revision: Number(update.revision ? 2 : 1),
    }),
  )
  const tx = {
    venue: { findFirst: vi.fn(async () => ({ id: 'venue-1' })) },
    venueDistribution: {
      findFirst: vi.fn(async () => ({
        websiteState: 'DISABLED',
        appState: 'DISABLED',
        revision: 1,
      })),
      upsert,
    },
    venueWebsiteOrigin: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 19),
      create: vi.fn(async () => ({ id: 'origin-1', origin: 'https://host.example' })),
    },
    approvalRequest: {
      findFirst: vi.fn(async () => ({
        id: 'approval-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        reason: 'Asked by venue owner',
        scopeSnapshot: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedRevision: 1,
          change: { kind: 'SET_SURFACE', surface: 'WEBSITE', enabled: true },
        },
      })),
    },
    approvalDecision: { create: vi.fn(async () => ({ id: 'decision-1' })) },
    agentAction: { create: vi.fn(async () => ({ id: 'action-1' })) },
  }
  const read = {
    venue: {
      findFirst: vi.fn(async () => ({
        id: 'venue-1',
        slug: 'harbor-bundle',
        name: 'Harbor bundle',
        isActive: true,
        chatTheme: 'default',
        chatAccentColor: null,
      })),
    },
    venueDistribution: { findFirst: vi.fn(async () => null) },
    venueWebsiteOrigin: { findMany: vi.fn(async () => []) },
    approvalRequest: { findMany: vi.fn(async () => []) },
    analyticsEvent: { count: vi.fn(async () => 7) },
    place: {
      findMany: vi.fn(async () => [{ id: 'place-1', name: 'Harbor Aquarium', type: 'ATTRACTION' }]),
    },
  }
  return {
    tx,
    read,
    resolve: vi.fn(async () => ({
      venueId: 'venue-1',
      tenantId: 'tenant-1',
      website: { effective: false, reason: 'SURFACE_DISABLED', framed: false, frameReason: null },
      app: { effective: false, reason: 'SURFACE_DISABLED' },
    })),
    sessionCounts: vi.fn(async () => ({ direct: 0, qr: 0, website: 0, app: 0, unknown: 0 })),
    upsert,
    normalizeOrigin: vi.fn(() => 'https://host.example'),
    audit: vi.fn(async () => undefined),
    transaction: vi.fn(async (callback: (tx: never) => Promise<unknown>) => callback(tx as never)),
  }
})

vi.mock('@pathfinder/db', () => ({
  db: { $transaction: mocks.transaction, ...mocks.read },
  writeAuditLogStrict: mocks.audit,
  normalizeVenueWebsiteOrigin: mocks.normalizeOrigin,
  resolveVenueDistribution: mocks.resolve,
  getVenueDistributionSessionCounts: mocks.sessionCounts,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminVenueDistributionRouter } from './venue-distribution'

const app = router({ admin: adminVenueDistributionRouter })
const ctx = {
  db: {},
  headers: new Headers(),
  session: { userId: 'admin-1', activeTenantId: null, role: null, isPlatformAdmin: true },
} as unknown as TRPCContext

describe('admin venue distribution readback', () => {
  it('lists only active public places of the exact venue for partner ID mapping', async () => {
    const result = await app.createCaller(ctx).admin.venueDistribution.get({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })
    expect(result.publicPlaces).toEqual([
      { id: 'place-1', name: 'Harbor Aquarium', type: 'ATTRACTION' },
    ])
    expect(result.appHandBacks30d).toBe(7)
    expect(mocks.read.analyticsEvent.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        eventType: 'visitor.action.clicked',
        metadata: { path: ['analyticsKey'], equals: 'host.open-in-app' },
      }),
    })
    expect(mocks.read.place.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', venueId: 'venue-1', isActive: true, visibility: 'PUBLIC' },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 500,
      select: { id: true, name: true, type: true },
    })
  })
})

describe('admin venue distribution mutations', () => {
  beforeEach(() => vi.clearAllMocks())

  it('persists requested surface transitions when a distribution row already exists', async () => {
    const result = await app.createCaller(ctx).admin.venueDistribution.setSurfaceState({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      surface: 'website',
      state: 'ENABLED',
      reason: 'approved launch',
    })
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId_tenantId: { venueId: 'venue-1', tenantId: 'tenant-1' } },
        update: expect.objectContaining({ websiteState: 'ENABLED', revision: { increment: 1 } }),
      }),
    )
    expect(result.websiteState).toBe('ENABLED')
    expect(mocks.audit).toHaveBeenCalledOnce()
  })

  it('applies only the exact pending proposal through a human decision and audit', async () => {
    const result = await app.createCaller(ctx).admin.venueDistribution.applyProposal({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      approvalRequestId: 'approval-1',
    })
    expect(result).toEqual({ approvalDecisionId: 'decision-1', revision: 2, applied: true })
    expect(mocks.tx.approvalRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'approval-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          decision: { is: null },
        }),
      }),
    )
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ websiteState: 'ENABLED' }) }),
    )
    expect(mocks.tx.approvalDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'APPROVED',
          decidedByType: 'HUMAN',
          decidedById: 'admin-1',
        }),
      }),
    )
    expect(mocks.audit).toHaveBeenCalledOnce()
  })

  it('rejects a stale proposal before any distribution mutation or decision', async () => {
    mocks.tx.approvalRequest.findFirst.mockResolvedValueOnce({
      id: 'approval-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      reason: 'Asked by venue owner',
      scopeSnapshot: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedRevision: 0,
        change: { kind: 'SET_SURFACE', surface: 'WEBSITE', enabled: true },
      },
    })
    await expect(
      app.createCaller(ctx).admin.venueDistribution.applyProposal({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        approvalRequestId: 'approval-1',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.upsert).not.toHaveBeenCalled()
    expect(mocks.tx.approvalDecision.create).not.toHaveBeenCalled()
  })

  it('locks the venue distribution row before counting origins for direct and proposed additions', async () => {
    await app.createCaller(ctx).admin.venueDistribution.addOrigin({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      origin: 'https://host.example',
      reason: 'approved host',
    })
    expect(mocks.upsert.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.tx.venueWebsiteOrigin.count.mock.invocationCallOrder[0]!,
    )
    vi.clearAllMocks()

    mocks.tx.approvalRequest.findFirst.mockResolvedValueOnce({
      id: 'approval-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      reason: 'Requested by owner',
      scopeSnapshot: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedRevision: 1,
        change: { kind: 'ADD_ORIGIN', origin: 'https://host.example' },
      },
    } as never)
    await app.createCaller(ctx).admin.venueDistribution.applyProposal({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      approvalRequestId: 'approval-1',
    })
    expect(mocks.upsert.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.tx.venueWebsiteOrigin.count.mock.invocationCallOrder[0]!,
    )
  })
})
