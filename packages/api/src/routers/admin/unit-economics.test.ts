import { describe, expect, it, vi } from 'vitest'

import { readFounderUnitEconomics } from './unit-economics'

describe('readFounderUnitEconomics', () => {
  it('combines AI estimates with contained current evidence and exposes coverage limits', async () => {
    const now = new Date('2026-08-25T00:00:00.000Z')
    const groupBy = vi
      .fn()
      .mockResolvedValueOnce([
        { tenantId: 'tenant-1', _sum: { estimatedCostUsd: '10.00000000' }, _count: { _all: 7 } },
      ])
      .mockResolvedValueOnce([
        { tenantId: 'tenant-1', _sum: { estimatedCostUsd: '20.00000000' }, _count: { _all: 9 } },
      ])
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'current-tenant',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        category: 'INFRASTRUCTURE',
        evidenceKind: 'OBSERVED',
        amountUsd: '5.00000000',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        periodEnd: new Date('2026-08-24T00:00:00.000Z'),
        sourceSystem: 'hosting',
      },
      {
        id: 'current-platform',
        tenantId: null,
        venueId: null,
        category: 'STORAGE',
        evidenceKind: 'ALLOCATED',
        amountUsd: '3.00000000',
        periodStart: new Date('2026-08-05T00:00:00.000Z'),
        periodEnd: new Date('2026-08-20T00:00:00.000Z'),
        sourceSystem: 'storage',
      },
      {
        id: 'overlap-excluded',
        tenantId: null,
        venueId: null,
        category: 'OTHER',
        evidenceKind: 'ESTIMATED',
        amountUsd: '99.00000000',
        periodStart: new Date('2026-07-01T00:00:00.000Z'),
        periodEnd: new Date('2026-08-10T00:00:00.000Z'),
        sourceSystem: 'manual',
      },
      {
        id: 'previous',
        tenantId: null,
        venueId: null,
        category: 'EMAIL',
        evidenceKind: 'OBSERVED',
        amountUsd: '4.00000000',
        periodStart: new Date('2026-07-01T00:00:00.000Z'),
        periodEnd: new Date('2026-07-20T00:00:00.000Z'),
        sourceSystem: 'email',
      },
    ])

    const result = await readFounderUnitEconomics(now, {
      aiUsageEvent: { groupBy },
      operatingCostEvidence: { findMany },
      operationalUsageEvidence: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'intake-a',
            tenantId: 'tenant-1',
            venueId: 'venue-1',
            metric: 'INTAKE_DECLARED_BYTES',
            quantity: '12.000000',
            unit: 'BYTES',
            observedAt: new Date('2026-08-24T00:00:00.000Z'),
            sourceSystem: 'torchiko-database-declared-usage',
          },
          {
            id: 'intake-b',
            tenantId: 'tenant-2',
            venueId: 'venue-2',
            metric: 'INTAKE_DECLARED_BYTES',
            quantity: '30.500000',
            unit: 'BYTES',
            observedAt: new Date('2026-08-24T00:00:00.000Z'),
            sourceSystem: 'torchiko-database-declared-usage',
          },
          {
            id: 'intake-a-older',
            tenantId: 'tenant-1',
            venueId: 'venue-1',
            metric: 'INTAKE_DECLARED_BYTES',
            quantity: '999.000000',
            unit: 'BYTES',
            observedAt: new Date('2026-08-23T00:00:00.000Z'),
            sourceSystem: 'torchiko-database-declared-usage',
          },
        ]),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'queue-depth',
            tenantId: null,
            venueId: null,
            metric: 'QUEUE_DEPTH',
            quantity: '7.000000',
            unit: 'JOBS',
            observedAt: new Date('2026-08-24T23:55:00.000Z'),
            sourceSystem: 'bullmq-operational-snapshot',
          })
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
      },
    } as never)

    expect(result.totals).toEqual({
      knownOperatingCostUsd: '18.00000000',
      priorKnownOperatingCostUsd: '24.00000000',
      changeUsd: '-6.00000000',
      changePercent: -25,
    })
    expect(result.ai).toMatchObject({
      estimatedCostUsd: '10.00000000',
      requestCount: 7,
      attributedTenantCount: 1,
      completeness: 'PROVIDER_PRICING_ESTIMATE',
    })
    expect(result.nonAi).toMatchObject({
      evidencedCostUsd: '8.00000000',
      platformUnallocatedUsd: '3.00000000',
      tenantOrVenueAttributedUsd: '5.00000000',
      evidenceCount: 2,
      excludedOverlappingEvidenceCount: 1,
    })
    expect(result.nonAi.categories.find((row) => row.category === 'INFRASTRUCTURE')).toEqual({
      category: 'INFRASTRUCTURE',
      represented: true,
      amountUsd: '5.00000000',
      entryCount: 1,
      evidenceKinds: ['OBSERVED'],
    })
    expect(result.coverage.complete).toBe(false)
    expect(result.coverage.unrepresentedCategories).toContain('SECURITY')
    expect(result.operationalUsage).toMatchObject({
      rowsReturned: 3,
      truncated: false,
      freshness: { declaredUsageDays: 2, queueUsageMinutes: 60 },
      representedMetrics: ['INTAKE_DECLARED_BYTES', 'QUEUE_DEPTH'],
      unrepresentedMetrics: [
        'MEDIA_DECLARED_BYTES',
        'QUEUE_FAILED_JOBS',
        'QUEUE_OLDEST_AGE_MILLISECONDS',
      ],
      assignsDollarValue: false,
      definesAnomalyThreshold: false,
    })
    expect(
      result.operationalUsage.metrics.find((row) => row.metric === 'INTAKE_DECLARED_BYTES'),
    ).toMatchObject({ quantity: '42.5', unit: 'BYTES', scopeCount: 2 })
    expect(result.policy).toEqual({
      anomalyThreshold: 'UNRESOLVED',
      anomalyClassification: 'NOT_COMPUTED',
      affectsInvoices: false,
      affectsCustomerPricing: false,
      authorizesServiceCutoff: false,
    })
  })
})
