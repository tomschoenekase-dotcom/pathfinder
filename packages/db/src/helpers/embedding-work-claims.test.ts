import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  deleteMany: vi.fn(),
  findFirst: vi.fn(),
}))

vi.mock('../client', () => ({
  db: {
    $queryRaw: mocks.queryRaw,
    embeddingWorkClaim: {
      deleteMany: mocks.deleteMany,
      findFirst: mocks.findFirst,
    },
  },
}))

import { acquireEmbeddingWork, releaseEmbeddingWork } from './embedding-work-claims'

const identity = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  entityType: 'PLACE' as const,
  entityId: 'place_1',
  contentUpdatedAt: new Date('2026-08-07T20:59:00.000Z'),
  sourceHash: 'a'.repeat(64),
  embeddingProfile: 'openai:text-embedding-3-small:1536',
  leaseToken: 'lease_1',
}

describe('embedding work claims', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the atomic upsert owner', async () => {
    mocks.queryRaw.mockResolvedValue([{ id: 'claim_1' }])

    await expect(acquireEmbeddingWork(identity)).resolves.toEqual({
      state: 'acquired',
      claimId: 'claim_1',
    })
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })

  it('returns complete only for the exact durable identity', async () => {
    mocks.queryRaw.mockResolvedValue([])
    mocks.findFirst.mockResolvedValue({
      id: 'claim_1',
      status: 'COMPLETE',
      contentUpdatedAt: identity.contentUpdatedAt,
      sourceHash: identity.sourceHash,
      embeddingProfile: identity.embeddingProfile,
    })

    await expect(acquireEmbeddingWork(identity)).resolves.toEqual({ state: 'complete' })
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        entityType: 'PLACE',
        entityId: 'place_1',
      },
      select: expect.objectContaining({ status: true, sourceHash: true }),
    })
  })

  it.each([
    ['RUNNING', identity.sourceHash],
    ['COMPLETE', 'b'.repeat(64)],
    ['SUPERSEDED', identity.sourceHash],
  ])('returns leased for unresolved diagnostic state %s', async (status, sourceHash) => {
    mocks.queryRaw.mockResolvedValue([])
    mocks.findFirst.mockResolvedValue({
      id: 'claim_1',
      status,
      contentUpdatedAt: identity.contentUpdatedAt,
      sourceHash,
      embeddingProfile: identity.embeddingProfile,
    })

    await expect(acquireEmbeddingWork(identity)).resolves.toEqual({ state: 'leased' })
  })

  it('releases only the scoped current fencing token', async () => {
    mocks.deleteMany.mockResolvedValue({ count: 1 })

    await expect(
      releaseEmbeddingWork({
        claimId: 'claim_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        leaseToken: 'lease_1',
      }),
    ).resolves.toBe(true)
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'claim_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'RUNNING',
        leaseToken: 'lease_1',
      },
    })
  })
})
