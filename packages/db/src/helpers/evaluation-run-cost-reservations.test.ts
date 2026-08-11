import { beforeEach, describe, expect, it, vi } from 'vitest'

const resultMocks = vi.hoisted(() => ({ createOrReplayEvaluationResult: vi.fn() }))
vi.mock('./evaluation-results', () => ({
  createOrReplayEvaluationResult: resultMocks.createOrReplayEvaluationResult,
}))

import {
  persistEvaluationResultWithLease,
  persistEvaluationResultWithCostReservation,
  reserveEvaluationRunCaseCost,
} from './evaluation-run-cost-reservations'

const scope = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  runId: '11111111-1111-4111-8111-111111111111',
  runIdentityHash: 'a'.repeat(64),
  caseId: '22222222-2222-4222-8222-222222222222',
  caseRevision: 1,
  caseHash: 'b'.repeat(64),
  attemptNumber: 1,
  leaseToken: '44444444-4444-4444-8444-444444444444',
  reservedCostE8Usd: 40n,
}

function client(overrides: Record<string, unknown> = {}) {
  const tx = {
    evalRun: {
      findFirst: vi.fn(async () => ({
        declaredBudgetCeilingE8Usd: 100n,
        budgetAccountedE8Usd: 20n,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    evalRunCostReservation: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => ({ id: 'reservation-1', status: 'RESERVED', ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    ...overrides,
  }
  return { tx, db: { ...tx, $transaction: vi.fn(async (callback) => callback(tx)) } }
}

describe('evaluation run cost reservations', () => {
  beforeEach(() => resultMocks.createOrReplayEvaluationResult.mockReset())

  it('atomically accounts the maximum cost before creating exact provider authorization', async () => {
    const { db, tx } = client()
    const acquired = await reserveEvaluationRunCaseCost({ db: db as never, ...scope })
    expect(acquired.state).toBe('reserved')
    expect(tx.evalRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'RUNNING',
          attemptNumber: 1,
          budgetAccountedE8Usd: { lte: 60n },
        }),
        data: { budgetAccountedE8Usd: { increment: 40n } },
      }),
    )
    expect(tx.evalRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          cancellationRequestedAt: null,
          executionLeaseToken: scope.leaseToken,
          executionLeaseExpiresAt: { gt: expect.any(Date) },
        }),
      }),
    )
    expect(tx.evalRunCostReservation.create).toHaveBeenCalledOnce()
  })

  it('treats a retained reservation as ambiguous and never grants retry dispatch', async () => {
    const existing = { id: 'reservation-old', status: 'RESERVED', ...scope }
    const { db, tx } = client({
      evalRunCostReservation: {
        findFirst: vi.fn(async () => existing),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    })
    await expect(reserveEvaluationRunCaseCost({ db: db as never, ...scope })).resolves.toEqual({
      state: 'ambiguous',
      reservation: existing,
    })
    expect(tx.evalRun.updateMany).not.toHaveBeenCalled()
  })

  it('settles result evidence and reservation state inside one transaction', async () => {
    const { db, tx } = client()
    resultMocks.createOrReplayEvaluationResult.mockResolvedValueOnce({
      evalResult: { id: '33333333-3333-4333-8333-333333333333' },
      replayed: false,
    })
    await persistEvaluationResultWithCostReservation({
      db: db as never,
      resultId: '33333333-3333-4333-8333-333333333333',
      reservationId: 'reservation-1',
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      runId: scope.runId,
      runIdentityHash: scope.runIdentityHash,
      evalCaseId: scope.caseId,
      caseRevision: 1,
      latencyMs: 3,
      costE8Usd: 7n,
      terminal: { outcome: 'OPERATIONAL_FAILURE', errorCode: 'MODEL_FAILED' },
      settlement: 'exact',
      attemptNumber: 1,
      leaseToken: scope.leaseToken,
    })
    expect(resultMocks.createOrReplayEvaluationResult).toHaveBeenCalledWith(
      expect.objectContaining({ db: tx }),
    )
    expect(tx.evalRunCostReservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'RESERVED' }),
        data: expect.objectContaining({ status: 'SETTLED', settledCostE8Usd: 7n }),
      }),
    )
  })

  it('rejects stale holder A after lease takeover B before result or settlement writes', async () => {
    const { db, tx } = client({
      evalRun: {
        findFirst: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    })
    await expect(
      persistEvaluationResultWithCostReservation({
        db: db as never,
        resultId: '33333333-3333-4333-8333-333333333333',
        reservationId: 'reservation-1',
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        runId: scope.runId,
        runIdentityHash: scope.runIdentityHash,
        evalCaseId: scope.caseId,
        caseRevision: 1,
        latencyMs: 3,
        costE8Usd: 7n,
        terminal: { outcome: 'OPERATIONAL_FAILURE', errorCode: 'MODEL_FAILED' },
        settlement: 'exact',
        attemptNumber: 1,
        leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).rejects.toThrow('lease is stale')
    expect(resultMocks.createOrReplayEvaluationResult).not.toHaveBeenCalled()
    expect(tx.evalRunCostReservation.updateMany).not.toHaveBeenCalled()
  })

  it('also fences terminal results that have no provider reservation', async () => {
    const { db } = client({
      evalRun: { findFirst: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })) },
    })
    await expect(
      persistEvaluationResultWithLease({
        db: db as never,
        resultId: '33333333-3333-4333-8333-333333333333',
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        runId: scope.runId,
        runIdentityHash: scope.runIdentityHash,
        evalCaseId: scope.caseId,
        caseRevision: 1,
        latencyMs: 0,
        costE8Usd: 0n,
        terminal: { outcome: 'BUDGET_BLOCKED', errorCode: 'RUN_BUDGET_CEILING' },
        attemptNumber: 2,
        leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    ).rejects.toThrow('lease is stale')
    expect(resultMocks.createOrReplayEvaluationResult).not.toHaveBeenCalled()
  })
})
