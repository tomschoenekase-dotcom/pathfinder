import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  auditCreate: vi.fn(),
}))

vi.mock('../client', () => ({
  db: {
    evalRun: { findFirst: mocks.findFirst, updateMany: mocks.updateMany },
    $transaction: (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        evalRun: { findFirst: mocks.findFirst, updateMany: mocks.updateMany },
        auditLog: { create: mocks.auditCreate },
      }),
  },
}))
vi.mock('../middleware/tenant-isolation', () => ({
  withTenantIsolationBypass: <T>(operation: () => Promise<T>) => operation(),
}))

import {
  claimEvaluationRunAttempt,
  failEvaluationRunAttempt,
  finishEvaluationRunAttempt,
  isEvaluationRunCancellationRequested,
  markEvaluationRunQueued,
  requestEvaluationRunCancellation,
  renewEvaluationRunLease,
} from './evaluation-run-lifecycle'

const scope = {
  runId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  runIdentityHash: 'a'.repeat(64),
}

describe('evaluation run lifecycle', () => {
  beforeEach(() => vi.resetAllMocks())

  it('claims an exact newer attempt through a scoped compare-and-set', async () => {
    mocks.findFirst.mockResolvedValue({
      status: 'QUEUED',
      attemptNumber: 0,
      maxAttempts: null,
      startedAt: null,
      cancellationRequestedAt: null,
    })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    await expect(
      claimEvaluationRunAttempt({ ...scope, attemptNumber: 1, maxAttempts: 3 }),
    ).resolves.toEqual(
      expect.objectContaining({
        state: 'acquired',
        cancellationRequested: false,
        attemptNumber: 1,
        leaseToken: expect.any(String),
      }),
    )
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: scope.runId,
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          identityHash: scope.runIdentityHash,
          status: 'QUEUED',
          attemptNumber: 0,
        }),
        data: expect.objectContaining({ status: 'RUNNING', attemptNumber: 1, maxAttempts: 3 }),
      }),
    )
  })

  it('advances only an exact STAGED identity to QUEUED', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    await expect(markEvaluationRunQueued(scope)).resolves.toBe(true)
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: scope.runId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        identityHash: scope.runIdentityHash,
        status: 'STAGED',
        cancellationRequestedAt: null,
      },
      data: { status: 'QUEUED' },
    })
  })

  it('never claims legacy or staged evidence as runnable work', async () => {
    mocks.findFirst
      .mockResolvedValueOnce({
        status: 'LEGACY',
        attemptNumber: 0,
        maxAttempts: null,
        startedAt: null,
        cancellationRequestedAt: null,
      })
      .mockResolvedValueOnce({
        status: 'STAGED',
        attemptNumber: 0,
        maxAttempts: null,
        startedAt: null,
        cancellationRequestedAt: null,
      })
    await expect(
      claimEvaluationRunAttempt({ ...scope, attemptNumber: 1, maxAttempts: 3 }),
    ).resolves.toEqual({ state: 'terminal' })
    await expect(
      claimEvaluationRunAttempt({ ...scope, attemptNumber: 1, maxAttempts: 3 }),
    ).resolves.toEqual({ state: 'not-admitted' })
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('refuses duplicate, changed-attempt, and terminal claims', async () => {
    mocks.findFirst.mockResolvedValueOnce({
      status: 'RUNNING',
      attemptNumber: 1,
      maxAttempts: 3,
      startedAt: new Date(),
      cancellationRequestedAt: null,
      executionLeaseToken: '11111111-1111-4111-8111-111111111111',
      executionLeaseExpiresAt: new Date(Date.now() + 60_000),
    })
    await expect(
      claimEvaluationRunAttempt({ ...scope, attemptNumber: 1, maxAttempts: 3 }),
    ).resolves.toEqual({ state: 'duplicate-attempt' })
    expect(mocks.updateMany).not.toHaveBeenCalled()

    mocks.findFirst.mockResolvedValueOnce({
      status: 'COMPLETED',
      attemptNumber: 1,
      maxAttempts: 3,
      startedAt: new Date(),
      cancellationRequestedAt: null,
    })
    await expect(
      claimEvaluationRunAttempt({ ...scope, attemptNumber: 2, maxAttempts: 3 }),
    ).resolves.toEqual({ state: 'terminal' })
  })

  it('fences and takes over an expired RUNNING lease without changing provider identity', async () => {
    const expiredAt = new Date('2026-08-11T20:00:00.000Z')
    const now = new Date('2026-08-11T20:01:00.000Z')
    mocks.findFirst.mockResolvedValueOnce({
      status: 'RUNNING',
      attemptNumber: 1,
      maxAttempts: 3,
      startedAt: expiredAt,
      cancellationRequestedAt: null,
      executionLeaseToken: '11111111-1111-4111-8111-111111111111',
      executionLeaseExpiresAt: expiredAt,
    })
    mocks.updateMany.mockResolvedValueOnce({ count: 1 })
    const claim = await claimEvaluationRunAttempt({
      ...scope,
      attemptNumber: 2,
      maxAttempts: 3,
      now,
    })
    expect(claim).toEqual(
      expect.objectContaining({
        state: 'acquired',
        attemptNumber: 2,
        leaseToken: expect.any(String),
      }),
    )
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'RUNNING',
          executionLeaseToken: '11111111-1111-4111-8111-111111111111',
          executionLeaseExpiresAt: expiredAt,
          cancellationRequestedAt: null,
        }),
        data: expect.objectContaining({
          attemptNumber: 2,
          executionLeaseToken: expect.any(String),
        }),
      }),
    )
  })

  it('renews only a live exact lease with no committed cancellation', async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 })
    await expect(
      renewEvaluationRunLease({
        ...scope,
        leaseToken: '11111111-1111-4111-8111-111111111111',
        now: new Date('2026-08-11T20:00:00.000Z'),
      }),
    ).resolves.toBe(true)
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'RUNNING',
          cancellationRequestedAt: null,
          executionLeaseExpiresAt: { gt: expect.any(Date) },
        }),
      }),
    )
  })

  it('uses durable attempts through crash takeover, failure, and RETRY_SCHEDULED reclaim', async () => {
    const expiredAt = new Date('2026-08-11T20:00:00.000Z')
    const now = new Date('2026-08-11T20:01:00.000Z')
    mocks.findFirst
      .mockResolvedValueOnce({
        status: 'RUNNING',
        attemptNumber: 1,
        maxAttempts: 3,
        startedAt: expiredAt,
        cancellationRequestedAt: null,
        executionLeaseToken: scope.runId,
        executionLeaseExpiresAt: expiredAt,
      })
      .mockResolvedValueOnce({
        status: 'RETRY_SCHEDULED',
        attemptNumber: 2,
        maxAttempts: 3,
        startedAt: expiredAt,
        cancellationRequestedAt: null,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    const takeover = await claimEvaluationRunAttempt({
      ...scope,
      attemptNumber: 99,
      maxAttempts: 3,
      now,
    })
    expect(takeover).toEqual(expect.objectContaining({ state: 'acquired', attemptNumber: 2 }))
    if (takeover.state !== 'acquired') throw new Error('expected takeover')
    await expect(
      failEvaluationRunAttempt({
        ...scope,
        attemptNumber: takeover.attemptNumber,
        maxAttempts: 3,
        leaseToken: takeover.leaseToken,
        errorCode: 'EVALUATION_EXECUTION_FAILED',
      }),
    ).resolves.toBe('retry-eligible')
    const retry = await claimEvaluationRunAttempt({
      ...scope,
      attemptNumber: 1,
      maxAttempts: 3,
      now,
    })
    expect(retry).toEqual(expect.objectContaining({ state: 'acquired', attemptNumber: 3 }))
  })

  it('recovers an expired maximum durable attempt without exceeding advertised attempts', async () => {
    const expiredAt = new Date('2026-08-11T20:00:00.000Z')
    const now = new Date('2026-08-11T20:01:00.000Z')
    mocks.findFirst.mockResolvedValueOnce({
      status: 'RUNNING',
      attemptNumber: 3,
      maxAttempts: 3,
      startedAt: expiredAt,
      cancellationRequestedAt: null,
      executionLeaseToken: scope.runId,
      executionLeaseExpiresAt: expiredAt,
    })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    const claim = await claimEvaluationRunAttempt({
      ...scope,
      attemptNumber: 42,
      maxAttempts: 3,
      now,
    })
    expect(claim).toEqual(expect.objectContaining({ state: 'acquired', attemptNumber: 3 }))
    if (claim.state !== 'acquired') throw new Error('expected max-attempt recovery')
    await expect(
      failEvaluationRunAttempt({
        ...scope,
        attemptNumber: 3,
        maxAttempts: 3,
        leaseToken: claim.leaseToken,
        errorCode: 'EVALUATION_EXECUTION_FAILED',
      }),
    ).resolves.toBe('failed')
  })

  it('terminalizes an impossible max-attempt RETRY_SCHEDULED row instead of stranding it', async () => {
    mocks.findFirst.mockResolvedValueOnce({
      status: 'RETRY_SCHEDULED',
      attemptNumber: 3,
      maxAttempts: 3,
      startedAt: new Date(),
      cancellationRequestedAt: null,
      executionLeaseToken: null,
      executionLeaseExpiresAt: null,
    })
    mocks.updateMany.mockResolvedValueOnce({ count: 1 })
    await expect(
      claimEvaluationRunAttempt({ ...scope, attemptNumber: 1, maxAttempts: 3 }),
    ).resolves.toEqual({ state: 'terminal' })
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'RETRY_SCHEDULED', attemptNumber: 3 }),
        data: expect.objectContaining({
          status: 'FAILED',
          lastErrorCode: 'EVALUATION_ATTEMPTS_EXHAUSTED',
        }),
      }),
    )
  })

  it('rejects an unknown failure code before persistence', async () => {
    await expect(
      failEvaluationRunAttempt({
        ...scope,
        attemptNumber: 1,
        maxAttempts: 3,
        leaseToken: '11111111-1111-4111-8111-111111111111',
        errorCode: 'UPSTREAM_SECRET_TOKEN',
      } as never),
    ).rejects.toThrow('Evaluation failure code is invalid')
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('parks retryable failures without claiming worker ownership and makes the final failure terminal', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    await expect(
      failEvaluationRunAttempt({
        ...scope,
        attemptNumber: 1,
        maxAttempts: 3,
        leaseToken: '11111111-1111-4111-8111-111111111111',
        errorCode: 'EVALUATION_EXECUTION_FAILED',
      }),
    ).resolves.toBe('retry-eligible')
    expect(mocks.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RETRY_SCHEDULED' }) }),
    )
    await expect(
      failEvaluationRunAttempt({
        ...scope,
        attemptNumber: 3,
        maxAttempts: 3,
        leaseToken: '11111111-1111-4111-8111-111111111111',
        errorCode: 'EVALUATION_EXECUTION_FAILED',
      }),
    ).resolves.toBe('failed')
    expect(mocks.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    )
  })

  it('finishes only the currently claimed attempt', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    await expect(
      finishEvaluationRunAttempt({
        ...scope,
        attemptNumber: 2,
        leaseToken: '11111111-1111-4111-8111-111111111111',
        outcome: 'CANCELLED',
      }),
    ).resolves.toBe(true)
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'RUNNING', attemptNumber: 2 }),
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    )
  })

  it('atomically converts a completion race with cancellation into CANCELLED', async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })
    await expect(
      finishEvaluationRunAttempt({
        ...scope,
        attemptNumber: 2,
        leaseToken: '11111111-1111-4111-8111-111111111111',
        outcome: 'COMPLETED',
      }),
    ).resolves.toBe(true)
    expect(mocks.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ cancellationRequestedAt: null }),
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    )
    expect(mocks.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ cancellationRequestedAt: { not: null } }),
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    )
  })

  it('does not let an expired exact-token holder finish or win cancellation fallback', async () => {
    const now = new Date('2026-08-11T21:00:00.000Z')
    mocks.updateMany.mockResolvedValue({ count: 0 })
    await expect(
      finishEvaluationRunAttempt({
        ...scope,
        attemptNumber: 2,
        leaseToken: '11111111-1111-4111-8111-111111111111',
        outcome: 'COMPLETED',
        now,
      }),
    ).resolves.toBe(false)
    expect(mocks.updateMany).toHaveBeenCalledTimes(2)
    for (const [call] of mocks.updateMany.mock.calls) {
      expect(call).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({ executionLeaseExpiresAt: { gt: now } }),
        }),
      )
    }
  })

  it('does not let an expired exact-token holder fail or cancel the run', async () => {
    const now = new Date('2026-08-11T21:00:00.000Z')
    mocks.updateMany.mockResolvedValue({ count: 0 })
    await expect(
      failEvaluationRunAttempt({
        ...scope,
        attemptNumber: 2,
        maxAttempts: 3,
        leaseToken: '11111111-1111-4111-8111-111111111111',
        errorCode: 'EVALUATION_EXECUTION_FAILED',
        now,
      }),
    ).resolves.toBe('stale')
    expect(mocks.updateMany).toHaveBeenCalledTimes(2)
    for (const [call] of mocks.updateMany.mock.calls) {
      expect(call).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({ executionLeaseExpiresAt: { gt: now } }),
        }),
      )
    }
  })

  it('persists idempotent cancellation and checks the full run scope', async () => {
    mocks.findFirst
      .mockResolvedValueOnce({ status: 'RUNNING', cancellationRequestedAt: null })
      .mockResolvedValueOnce({ status: 'RUNNING', cancellationRequestedAt: new Date() })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    await expect(
      requestEvaluationRunCancellation({
        runId: scope.runId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        requestedBy: 'operator_1',
        requestedByRole: 'PLATFORM_ADMIN',
      }),
    ).resolves.toBe('requested')
    await expect(isEvaluationRunCancellationRequested(scope)).resolves.toBe(true)
    expect(mocks.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          id: scope.runId,
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          identityHash: scope.runIdentityHash,
        },
      }),
    )
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: 'operator_1',
          actorRole: 'PLATFORM_ADMIN',
          action: 'evaluation.run.cancellation-requested',
          targetId: scope.runId,
        }),
      }),
    )
  })

  it('fails the cancellation transaction when strict audit persistence fails', async () => {
    mocks.findFirst.mockResolvedValue({ status: 'RUNNING', cancellationRequestedAt: null })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.auditCreate.mockRejectedValue(new Error('audit unavailable'))
    await expect(
      requestEvaluationRunCancellation({
        runId: scope.runId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        requestedBy: 'operator_1',
        requestedByRole: 'PLATFORM_ADMIN',
      }),
    ).rejects.toThrow('audit unavailable')
  })

  it('cancels queued work immediately and replays its cancellation idempotently', async () => {
    const requestedAt = new Date('2026-08-11T20:00:00.000Z')
    mocks.findFirst
      .mockResolvedValueOnce({ status: 'QUEUED', cancellationRequestedAt: null })
      .mockResolvedValueOnce({ status: 'CANCELLED', cancellationRequestedAt: requestedAt })
    mocks.updateMany.mockResolvedValueOnce({ count: 1 })
    const request = {
      runId: scope.runId,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      requestedBy: 'operator_1',
      requestedByRole: 'PLATFORM_ADMIN',
    }
    await expect(requestEvaluationRunCancellation(request)).resolves.toBe('requested')
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED', completedAt: expect.any(Date) }),
      }),
    )
    await expect(requestEvaluationRunCancellation(request)).resolves.toBe('already-requested')
    expect(mocks.updateMany).toHaveBeenCalledOnce()
    expect(mocks.auditCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'evaluation.run.cancellation-already-requested',
        }),
      }),
    )
  })

  it('re-reads a cancellation CAS miss instead of claiming unsupported success', async () => {
    mocks.findFirst
      .mockResolvedValueOnce({ status: 'RUNNING', cancellationRequestedAt: null })
      .mockResolvedValueOnce({ status: 'COMPLETED', cancellationRequestedAt: null })
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(
      requestEvaluationRunCancellation({
        runId: scope.runId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        requestedBy: 'operator_1',
        requestedByRole: 'PLATFORM_ADMIN',
      }),
    ).resolves.toBe('terminal')
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'evaluation.run.cancellation-terminal' }),
      }),
    )
  })
})
