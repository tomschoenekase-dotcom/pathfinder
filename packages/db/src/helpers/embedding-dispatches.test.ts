import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
}))

vi.mock('../client', () => ({
  db: {
    $executeRaw: mocks.executeRaw,
    $queryRaw: mocks.queryRaw,
    embeddingDispatch: { deleteMany: mocks.deleteMany },
  },
}))

import {
  acknowledgeEmbeddingDispatch,
  failEmbeddingDispatch,
  leaseEmbeddingDispatchBatch,
} from './embedding-dispatches'

const revision = new Date('2026-08-07T22:30:00.123Z')

describe('embedding dispatch outbox', () => {
  beforeEach(() => vi.clearAllMocks())

  it('leases a bounded batch with the supplied fencing token', async () => {
    const rows = [
      {
        id: 'place:place_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        entityType: 'PLACE',
        entityId: 'place_1',
        contentUpdatedAt: revision,
      },
    ]
    mocks.queryRaw.mockResolvedValue(rows)

    await expect(
      leaseEmbeddingDispatchBatch({ batchSize: 5_000, leaseToken: 'lease_1' }),
    ).resolves.toEqual({ leaseToken: 'lease_1', dispatches: rows })
    expect(mocks.queryRaw.mock.calls[0]?.slice(1)).toContain(500)
    expect(mocks.queryRaw.mock.calls[0]?.slice(1)).toContain('lease_1')
  })

  it('acknowledges only the exact scoped revision and lease token', async () => {
    mocks.deleteMany.mockResolvedValue({ count: 1 })

    await expect(
      acknowledgeEmbeddingDispatch({
        id: 'place:place_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        contentUpdatedAt: revision,
        leaseToken: 'lease_1',
      }),
    ).resolves.toBe(true)
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'place:place_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        contentUpdatedAt: revision,
        leaseToken: 'lease_1',
      },
    })
  })

  it('releases the exact failed lease with bounded diagnostic text', async () => {
    mocks.executeRaw.mockResolvedValue(1)

    await expect(
      failEmbeddingDispatch({
        id: 'place:place_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        contentUpdatedAt: revision,
        leaseToken: 'lease_1',
        error: 'x'.repeat(1_500),
      }),
    ).resolves.toBe(true)
    expect(mocks.executeRaw.mock.calls[0]?.slice(1)).toContain('x'.repeat(1_000))
  })
})
