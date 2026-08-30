import { describe, expect, it, vi } from 'vitest'

import { inspectDeclaredOperationalUsage } from './declared-operational-usage'

function client() {
  return {
    intakeUpload: {
      groupBy: vi.fn().mockResolvedValue([
        {
          tenantId: 'tenant-b',
          venueId: 'venue-2',
          _sum: { byteSize: 5 },
          _count: { _all: 1 },
        },
        {
          tenantId: 'tenant-a',
          venueId: 'venue-1',
          _sum: { byteSize: 12 },
          _count: { _all: 2 },
        },
      ]),
    },
    mediaIngestionProject: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'project-1', tenantId: 'tenant-a', venueId: 'venue-1', sourceBytes: 100n },
        { id: 'project-2', tenantId: 'tenant-b', venueId: 'venue-2', sourceBytes: null },
      ]),
    },
    mediaIngestionAsset: {
      groupBy: vi.fn().mockResolvedValue([
        {
          tenantId: 'tenant-a',
          projectId: 'project-1',
          _sum: { bytes: 30n },
          _count: { _all: 2 },
        },
      ]),
    },
  }
}

describe('inspectDeclaredOperationalUsage', () => {
  it('returns deterministic venue-scoped declared byte gauges without monetary claims', async () => {
    const result = await inspectDeclaredOperationalUsage(
      new Date('2026-08-25T08:00:00Z'),
      client() as never,
    )

    expect(result.scopes).toEqual([
      {
        tenantId: 'tenant-a',
        venueId: 'venue-1',
        intakeDeclaredBytes: 12n,
        mediaDeclaredBytes: 130n,
      },
      {
        tenantId: 'tenant-b',
        venueId: 'venue-2',
        intakeDeclaredBytes: 5n,
        mediaDeclaredBytes: 0n,
      },
    ])
    expect(result.limitations).toEqual({
      providerInventoryObserved: false,
      retentionStateObserved: false,
      transferBytesObserved: false,
      dollarCostAssigned: false,
    })
  })

  it('fails closed when an asset cannot be reconciled to its tenant project', async () => {
    const mock = client()
    mock.mediaIngestionAsset.groupBy.mockResolvedValue([
      {
        tenantId: 'tenant-other',
        projectId: 'project-1',
        _sum: { bytes: 1n },
        _count: { _all: 1 },
      },
    ])

    await expect(inspectDeclaredOperationalUsage(new Date(), mock as never)).rejects.toThrow(
      'scope could not be reconciled',
    )
  })
})
