import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  resolve: vi.fn(),
  counts: vi.fn(),
  normalize: vi.fn((origin: string) => (origin === 'https://venue.example.com' ? origin : null)),
}))
vi.mock('@pathfinder/db', () => ({
  db: {},
  resolveVenueDistribution: mocked.resolve,
  getVenueDistributionSessionCounts: mocked.counts,
  normalizeVenueWebsiteOrigin: mocked.normalize,
}))

import { createDistributionMcpActions } from './distribution-actions'

const credential = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  venueIds: ['venue-1'],
  capabilities: ['distribution:read', 'distribution:propose'],
} as const
const context = {
  credential: {
    ...credential,
    venueIds: [...credential.venueIds],
    capabilities: [...credential.capabilities],
  },
}
const venue = { id: 'venue-1', tenantId: 'tenant-1', slug: 'venue', isActive: true }
const state = {
  venueId: 'venue-1',
  tenantId: 'tenant-1',
  revision: 2,
  website: { effective: false },
  app: { effective: false },
}

function database() {
  const tx = {
    approvalRequest: {
      create: vi.fn().mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    },
    agentAction: { create: vi.fn().mockResolvedValue({ id: 'action-1' }) },
    agentTimelineEvent: { create: vi.fn().mockResolvedValue({}) },
    agentRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  }
  return {
    venue: { findFirst: vi.fn().mockResolvedValue(venue) },
    venueWebsiteOrigin: { findMany: vi.fn().mockResolvedValue([]) },
    agentWorker: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'worker-1', modelProvider: null, modelName: null }),
    },
    agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent-1' }) },
    agentRun: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'run-1', requestedOperation: 'distribution review' }),
    },
    approvalRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (action: (client: typeof tx) => Promise<unknown>) => action(tx)),
    tx,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.resolve.mockResolvedValue(state)
  mocked.counts.mockResolvedValue({ direct: 0, qr: 0, website: 0, app: 0, unknown: 0 })
})

describe('distribution MCP actions', () => {
  it('reads only the credential tenant venue and returns resolver state', async () => {
    const client = database()
    const actions = createDistributionMcpActions(client as never)
    const result = await actions.distributionGet(
      { clientId: 'client-1', venueId: 'venue-1' },
      context as never,
    )
    expect(client.venue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'venue-1', tenantId: 'tenant-1' } }),
    )
    expect(result.data).toMatchObject({ state, counts: { direct: 0 } })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('retains a scoped approval request and does not mutate distribution', async () => {
    const client = database()
    const actions = createDistributionMcpActions(client as never)
    const result = await actions.distributionProposeChange(
      {
        clientId: 'client-1',
        venueId: 'venue-1',
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        reason: 'Venue asked for its website origin.',
        change: { kind: 'ADD_ORIGIN', origin: 'https://venue.example.com' },
      },
      context as never,
    )
    expect(result.data).toEqual({
      approvalRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      replayed: false,
      applied: false,
    })
    expect(client.tx.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          proposedAction: 'torchiko.distribution.apply_change',
          scopeSnapshot: {
            tenantId: 'tenant-1',
            venueId: 'venue-1',
            expectedRevision: 2,
            change: { kind: 'ADD_ORIGIN', origin: 'https://venue.example.com' },
          },
        }),
      }),
    )
    expect(client.tx.agentAction.create).toHaveBeenCalledOnce()
    expect(Object.keys(client.tx)).not.toContain('venueDistribution')
    expect(Object.keys(client.tx)).not.toContain('venueWebsiteOrigin')
  })

  it('rejects a malformed origin before creating an approval request', async () => {
    const client = database()
    const actions = createDistributionMcpActions(client as never)
    await expect(
      actions.distributionProposeChange(
        {
          clientId: 'client-1',
          venueId: 'venue-1',
          operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          agentIdentityId: 'agent-1',
          agentRunId: 'run-1',
          workerKey: 'worker-1',
          reason: 'Untrusted origin',
          change: { kind: 'ADD_ORIGIN', origin: 'https://*.example.com' },
        },
        context as never,
      ),
    ).rejects.toThrow('canonical HTTPS origin')
    expect(client.$transaction).not.toHaveBeenCalled()
  })
})
