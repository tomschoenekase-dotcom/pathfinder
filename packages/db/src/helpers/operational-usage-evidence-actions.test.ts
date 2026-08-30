import { describe, expect, it, vi } from 'vitest'

import {
  OperationalUsageEvidenceActionError,
  recordOperationalUsageEvidenceAction,
} from './operational-usage-evidence-actions'

const baseInput = {
  operationId: '11111111-1111-4111-8111-111111111111',
  metric: 'QUEUE_DEPTH' as const,
  measurementKind: 'GAUGE' as const,
  quantity: '7',
  unit: 'JOBS' as const,
  observedAt: new Date('2026-08-25T07:30:00.000Z'),
  sourceSystem: 'bullmq-operational-snapshot',
  sourceReference: '2026-08-25T07:30:00.000Z:queue-depth',
  sourceDigest: 'a'.repeat(64),
  actor: { type: 'SYSTEM' as const, id: 'worker:operational-usage', role: 'SYSTEM' as const },
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const created = {
    id: '22222222-2222-4222-8222-222222222222',
    ...baseInput,
    tenantId: null,
    venueId: null,
    periodStart: null,
    periodEnd: null,
    recordedByType: baseInput.actor.type,
    recordedById: baseInput.actor.id,
    recordedAt: new Date('2026-08-25T07:30:01.000Z'),
  }
  const transaction = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1' }) },
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-1' }) },
    operationalUsageEvidence: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(created),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    ...overrides,
  }
  const client = {
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) =>
      callback(transaction),
    ),
  }
  return { client, transaction, created }
}

describe('recordOperationalUsageEvidenceAction', () => {
  it('appends a system gauge without assigning financial or cutoff authority', async () => {
    const { client, transaction } = makeClient()

    const result = await recordOperationalUsageEvidenceAction(baseInput, client as never)

    expect(result.replayed).toBe(false)
    expect(transaction.operationalUsageEvidence.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: null,
          venueId: null,
          quantity: '7',
          unit: 'JOBS',
        }),
      }),
    )
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'operational-usage-evidence.recorded',
        afterState: expect.objectContaining({
          assignsDollarValue: false,
          affectsCustomerPricing: false,
          definesAnomalyThreshold: false,
          authorizesServiceCutoff: false,
        }),
      }),
    })
  })

  it('rejects a metric/unit mismatch before opening a transaction', async () => {
    const { client } = makeClient()

    await expect(
      recordOperationalUsageEvidenceAction({ ...baseInput, unit: 'BYTES' }, client as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('requires a valid interval only for interval totals', async () => {
    const { client } = makeClient()

    await expect(
      recordOperationalUsageEvidenceAction(
        { ...baseInput, periodStart: new Date('2026-08-25T07:00:00Z') },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      recordOperationalUsageEvidenceAction(
        {
          ...baseInput,
          measurementKind: 'INTERVAL_TOTAL' as never,
          periodStart: new Date('2026-08-25T07:00:00Z'),
          periodEnd: new Date('2026-08-25T07:00:00Z'),
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a venue outside the supplied tenant before writing', async () => {
    const { client, transaction } = makeClient()
    transaction.venue.findFirst.mockResolvedValue(null)

    await expect(
      recordOperationalUsageEvidenceAction(
        { ...baseInput, tenantId: 'tenant-1', venueId: 'venue-other' },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_NOT_FOUND' })
    expect(transaction.operationalUsageEvidence.create).not.toHaveBeenCalled()
  })

  it('returns an exact replay and rejects conflicting operation reuse', async () => {
    const { client, transaction, created } = makeClient()
    transaction.operationalUsageEvidence.findUnique.mockResolvedValue(created)

    await expect(
      recordOperationalUsageEvidenceAction(baseInput, client as never),
    ).resolves.toMatchObject({
      replayed: true,
    })
    expect(transaction.auditLog.create).not.toHaveBeenCalled()

    transaction.operationalUsageEvidence.findUnique.mockResolvedValue({
      ...created,
      sourceDigest: 'b'.repeat(64),
    })
    await expect(recordOperationalUsageEvidenceAction(baseInput, client as never)).rejects.toEqual(
      expect.objectContaining<Partial<OperationalUsageEvidenceActionError>>({
        code: 'IDEMPOTENCY_CONFLICT',
      }),
    )
  })
})
