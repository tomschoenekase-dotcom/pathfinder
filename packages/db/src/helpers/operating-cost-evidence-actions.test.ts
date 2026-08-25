import { describe, expect, it, vi } from 'vitest'

import {
  OperatingCostEvidenceActionError,
  recordOperatingCostEvidenceAction,
} from './operating-cost-evidence-actions'

const baseInput = {
  operationId: '11111111-1111-4111-8111-111111111111',
  category: 'INFRASTRUCTURE' as const,
  evidenceKind: 'OBSERVED' as const,
  amountUsd: '42.50000000',
  periodStart: new Date('2026-08-01T00:00:00.000Z'),
  periodEnd: new Date('2026-08-02T00:00:00.000Z'),
  sourceSystem: 'hosting-export',
  sourceReference: 'invoice-line-42',
  description: 'Daily hosting allocation',
  actor: { type: 'HUMAN' as const, id: 'operator-1', role: 'PLATFORM_ADMIN' as const },
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const created = {
    id: '22222222-2222-4222-8222-222222222222',
    ...baseInput,
    tenantId: null,
    venueId: null,
    quantity: null,
    quantityUnit: null,
    supersedesId: null,
    recordedBy: baseInput.actor.id,
    recordedAt: new Date('2026-08-03T00:00:00.000Z'),
  }
  const transaction = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1' }) },
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-1' }) },
    operatingCostEvidence: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
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

describe('recordOperatingCostEvidenceAction', () => {
  it('appends platform evidence and a strict non-consequential audit record', async () => {
    const { client, transaction } = makeClient()

    const result = await recordOperatingCostEvidenceAction(baseInput, client as never)

    expect(result.replayed).toBe(false)
    expect(transaction.operatingCostEvidence.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: null,
          venueId: null,
          amountUsd: '42.50000000',
        }),
      }),
    )
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'operating-cost-evidence.recorded',
        afterState: expect.objectContaining({
          scope: 'PLATFORM',
          affectsInvoices: false,
          affectsCustomerPricing: false,
          authorizesServiceCutoff: false,
        }),
      }),
    })
  })

  it('rejects a venue outside the supplied tenant before writing evidence', async () => {
    const { client, transaction } = makeClient()
    transaction.venue.findFirst.mockResolvedValue(null)

    await expect(
      recordOperatingCostEvidenceAction(
        { ...baseInput, tenantId: 'tenant-1', venueId: 'venue-other' },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_NOT_FOUND' })
    expect(transaction.operatingCostEvidence.create).not.toHaveBeenCalled()
  })

  it('returns an exact operation replay without duplicating audit evidence', async () => {
    const { client, transaction, created } = makeClient()
    transaction.operatingCostEvidence.findUnique.mockResolvedValue(created)

    const result = await recordOperatingCostEvidenceAction(baseInput, client as never)

    expect(result.replayed).toBe(true)
    expect(transaction.operatingCostEvidence.create).not.toHaveBeenCalled()
    expect(transaction.auditLog.create).not.toHaveBeenCalled()
  })

  it('rejects reuse of an operation ID for different evidence', async () => {
    const { client, transaction, created } = makeClient()
    transaction.operatingCostEvidence.findUnique.mockResolvedValue({
      ...created,
      amountUsd: '99.00',
    })

    await expect(recordOperatingCostEvidenceAction(baseInput, client as never)).rejects.toEqual(
      expect.objectContaining<Partial<OperatingCostEvidenceActionError>>({
        code: 'IDEMPOTENCY_CONFLICT',
      }),
    )
  })

  it('only supersedes current evidence from the same scope, category, and source', async () => {
    const { client, transaction } = makeClient()
    transaction.operatingCostEvidence.findFirst.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      tenantId: null,
      venueId: null,
      category: 'STORAGE',
      sourceSystem: baseInput.sourceSystem,
    })

    await expect(
      recordOperatingCostEvidenceAction(
        { ...baseInput, supersedesId: '33333333-3333-4333-8333-333333333333' },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'SUPERSESSION_CONFLICT' })
    expect(transaction.operatingCostEvidence.create).not.toHaveBeenCalled()
  })

  it('rejects malformed periods and unpaired quantities before opening a transaction', async () => {
    const { client } = makeClient()

    await expect(
      recordOperatingCostEvidenceAction(
        {
          ...baseInput,
          quantity: '3',
          periodEnd: baseInput.periodStart,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })
})
