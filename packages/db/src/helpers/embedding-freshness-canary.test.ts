import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ executeRaw: vi.fn(), transaction: vi.fn() }))

vi.mock('../client', () => ({
  db: {
    $transaction: mocks.transaction,
  },
}))

import {
  EMBEDDING_FRESHNESS_CANARY_MAX,
  insertEmbeddingFreshnessCanary,
} from './embedding-freshness-canary'

describe('insertEmbeddingFreshnessCanary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(async (run) => run({ $executeRaw: mocks.executeRaw }))
  })

  it('rejects empty and oversized batches before opening a transaction', async () => {
    await expect(
      insertEmbeddingFreshnessCanary({ tenantId: 'tenant_1', venueId: 'venue_1', targets: [] }),
    ).rejects.toThrow('requires 1-10')
    await expect(
      insertEmbeddingFreshnessCanary({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        targets: Array.from({ length: EMBEDDING_FRESHNESS_CANARY_MAX + 1 }, (_, index) => ({
          entityType: 'PLACE' as const,
          entityId: `place_${index}`,
          contentUpdatedAt: new Date(0),
        })),
      }),
    ).rejects.toThrow('requires 1-10')
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('deduplicates targets and reports insert conflicts as skipped', async () => {
    mocks.executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    const revision = new Date('2026-08-07T20:00:00.000Z')
    await expect(
      insertEmbeddingFreshnessCanary({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        targets: [
          { entityType: 'PLACE', entityId: 'place_1', contentUpdatedAt: revision },
          { entityType: 'PLACE', entityId: 'place_1', contentUpdatedAt: revision },
          { entityType: 'KNOWLEDGE_ENTRY', entityId: 'entry_1', contentUpdatedAt: revision },
        ],
      }),
    ).resolves.toEqual({ inserted: ['place_1'], skipped: ['entry_1'] })
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2)
  })
})
