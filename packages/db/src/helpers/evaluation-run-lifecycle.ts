import { randomUUID } from 'node:crypto'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { writeAuditLogStrict } from './audit'

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,99}$/u
export const EVALUATION_RUN_EXECUTION_LEASE_MS = 15 * 60 * 1000

type Scope = {
  runId: string
  tenantId: string
  venueId: string
  runIdentityHash: string
}

export type EvaluationRunAttemptClaim =
  | { state: 'acquired'; cancellationRequested: false; attemptNumber: number; leaseToken: string }
  | { state: 'duplicate-attempt' | 'not-admitted' | 'terminal' | 'not-found' }

export async function markEvaluationRunQueued(scope: Scope): Promise<boolean> {
  return withTenantIsolationBypass(async () => {
    const result = await db.evalRun.updateMany({
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
    return result.count === 1
  })
}

export async function renewEvaluationRunLease(
  scope: Scope & { leaseToken: string; now?: Date },
): Promise<boolean> {
  const now = scope.now ?? new Date()
  return withTenantIsolationBypass(async () => {
    const renewed = await db.evalRun.updateMany({
      where: {
        id: scope.runId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        identityHash: scope.runIdentityHash,
        status: 'RUNNING',
        executionLeaseToken: scope.leaseToken,
        executionLeaseExpiresAt: { gt: now },
        cancellationRequestedAt: null,
      },
      data: {
        executionLeaseExpiresAt: new Date(now.getTime() + EVALUATION_RUN_EXECUTION_LEASE_MS),
      },
    })
    return renewed.count === 1
  })
}

export async function claimEvaluationRunAttempt(
  scope: Scope & { attemptNumber: number; maxAttempts: number; now?: Date },
): Promise<EvaluationRunAttemptClaim> {
  if (
    !Number.isInteger(scope.attemptNumber) ||
    scope.attemptNumber < 1 ||
    !Number.isInteger(scope.maxAttempts) ||
    scope.maxAttempts < 1
  ) {
    throw new Error('Evaluation attempt bounds are invalid')
  }
  return withTenantIsolationBypass(async () => {
    const now = scope.now ?? new Date()
    for (let casAttempt = 0; casAttempt < 2; casAttempt += 1) {
      const run = await db.evalRun.findFirst({
        where: {
          id: scope.runId,
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          identityHash: scope.runIdentityHash,
        },
        select: {
          status: true,
          attemptNumber: true,
          maxAttempts: true,
          startedAt: true,
          cancellationRequestedAt: true,
          executionLeaseToken: true,
          executionLeaseExpiresAt: true,
        },
      })
      if (!run) return { state: 'not-found' }
      if (['LEGACY', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
        return { state: 'terminal' }
      }
      if (run.status === 'RUNNING') {
        if (!run.executionLeaseExpiresAt || !run.executionLeaseToken)
          throw new Error('Evaluation RUNNING lease evidence is missing')
        if (run.executionLeaseExpiresAt > now) return { state: 'duplicate-attempt' }
        if (run.maxAttempts !== scope.maxAttempts)
          throw new Error('Evaluation max-attempt identity changed')
        const leaseToken = randomUUID()
        const attemptNumber = Math.min(run.attemptNumber + 1, scope.maxAttempts)
        const takeover = await db.evalRun.updateMany({
          where: {
            id: scope.runId,
            tenantId: scope.tenantId,
            venueId: scope.venueId,
            identityHash: scope.runIdentityHash,
            status: 'RUNNING',
            attemptNumber: run.attemptNumber,
            executionLeaseToken: run.executionLeaseToken,
            executionLeaseExpiresAt: run.executionLeaseExpiresAt,
            cancellationRequestedAt: null,
          },
          data: {
            attemptNumber,
            executionLeaseToken: leaseToken,
            executionLeaseExpiresAt: new Date(now.getTime() + EVALUATION_RUN_EXECUTION_LEASE_MS),
            lastErrorCode: null,
          },
        })
        if (takeover.count === 1)
          return { state: 'acquired', cancellationRequested: false, attemptNumber, leaseToken }
        continue
      }
      if (!['QUEUED', 'RETRY_SCHEDULED'].includes(run.status)) return { state: 'not-admitted' }
      if (run.maxAttempts !== null && run.maxAttempts !== scope.maxAttempts) {
        throw new Error('Evaluation max-attempt identity changed')
      }
      const attemptNumber = run.attemptNumber + 1
      if (attemptNumber > scope.maxAttempts) {
        const exhausted = await db.evalRun.updateMany({
          where: {
            id: scope.runId,
            tenantId: scope.tenantId,
            venueId: scope.venueId,
            identityHash: scope.runIdentityHash,
            status: 'RETRY_SCHEDULED',
            attemptNumber: run.attemptNumber,
            maxAttempts: scope.maxAttempts,
            cancellationRequestedAt: null,
          },
          data: {
            status: 'FAILED',
            completedAt: now,
            lastErrorCode: 'EVALUATION_ATTEMPTS_EXHAUSTED',
          },
        })
        if (exhausted.count === 1) return { state: 'terminal' }
        continue
      }
      const leaseToken = randomUUID()
      const advanced = await db.evalRun.updateMany({
        where: {
          id: scope.runId,
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          identityHash: scope.runIdentityHash,
          status: run.status,
          attemptNumber: run.attemptNumber,
          cancellationRequestedAt: null,
        },
        data: {
          status: 'RUNNING',
          attemptNumber,
          maxAttempts: scope.maxAttempts,
          startedAt: run.startedAt ?? now,
          completedAt: null,
          lastErrorCode: null,
          executionLeaseToken: leaseToken,
          executionLeaseExpiresAt: new Date(now.getTime() + EVALUATION_RUN_EXECUTION_LEASE_MS),
        },
      })
      if (advanced.count === 1) {
        return {
          state: 'acquired',
          cancellationRequested: false,
          attemptNumber,
          leaseToken,
        }
      }
    }
    return { state: 'duplicate-attempt' }
  })
}

export async function finishEvaluationRunAttempt(
  scope: Scope & {
    attemptNumber: number
    leaseToken: string
    outcome: 'COMPLETED' | 'CANCELLED'
    now?: Date
  },
): Promise<boolean> {
  return withTenantIsolationBypass(async () => {
    const now = scope.now ?? new Date()
    const result = await db.evalRun.updateMany({
      where: {
        id: scope.runId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        identityHash: scope.runIdentityHash,
        status: 'RUNNING',
        attemptNumber: scope.attemptNumber,
        executionLeaseToken: scope.leaseToken,
        executionLeaseExpiresAt: { gt: now },
        ...(scope.outcome === 'COMPLETED' ? { cancellationRequestedAt: null } : {}),
      },
      data: {
        status: scope.outcome,
        completedAt: now,
        lastErrorCode: null,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      },
    })
    if (result.count === 1) return true
    if (scope.outcome !== 'COMPLETED') return false
    const cancelled = await db.evalRun.updateMany({
      where: {
        id: scope.runId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        identityHash: scope.runIdentityHash,
        status: 'RUNNING',
        attemptNumber: scope.attemptNumber,
        executionLeaseToken: scope.leaseToken,
        executionLeaseExpiresAt: { gt: now },
        cancellationRequestedAt: { not: null },
      },
      data: {
        status: 'CANCELLED',
        completedAt: now,
        lastErrorCode: null,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      },
    })
    return cancelled.count === 1
  })
}

export async function failEvaluationRunAttempt(
  scope: Scope & {
    attemptNumber: number
    maxAttempts: number
    leaseToken: string
    errorCode: string
    now?: Date
  },
): Promise<'retry-eligible' | 'failed' | 'cancelled' | 'stale'> {
  if (!ERROR_CODE.test(scope.errorCode)) throw new Error('Evaluation failure code is invalid')
  return withTenantIsolationBypass(async () => {
    const now = scope.now ?? new Date()
    const finalAttempt = scope.attemptNumber >= scope.maxAttempts
    const result = await db.evalRun.updateMany({
      where: {
        id: scope.runId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        identityHash: scope.runIdentityHash,
        status: 'RUNNING',
        attemptNumber: scope.attemptNumber,
        maxAttempts: scope.maxAttempts,
        executionLeaseToken: scope.leaseToken,
        executionLeaseExpiresAt: { gt: now },
        cancellationRequestedAt: null,
      },
      data: {
        status: finalAttempt ? 'FAILED' : 'RETRY_SCHEDULED',
        lastErrorCode: scope.errorCode,
        completedAt: finalAttempt ? now : null,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      },
    })
    if (result.count !== 1) {
      const cancelled = await db.evalRun.updateMany({
        where: {
          id: scope.runId,
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          identityHash: scope.runIdentityHash,
          status: 'RUNNING',
          attemptNumber: scope.attemptNumber,
          maxAttempts: scope.maxAttempts,
          executionLeaseToken: scope.leaseToken,
          executionLeaseExpiresAt: { gt: now },
          cancellationRequestedAt: { not: null },
        },
        data: {
          status: 'CANCELLED',
          completedAt: now,
          lastErrorCode: null,
          executionLeaseToken: null,
          executionLeaseExpiresAt: null,
        },
      })
      return cancelled.count === 1 ? 'cancelled' : 'stale'
    }
    return finalAttempt ? 'failed' : 'retry-eligible'
  })
}

export async function isEvaluationRunCancellationRequested(scope: Scope): Promise<boolean> {
  return withTenantIsolationBypass(async () => {
    const run = await db.evalRun.findFirst({
      where: {
        id: scope.runId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        identityHash: scope.runIdentityHash,
      },
      select: { status: true, cancellationRequestedAt: true },
    })
    return !run || run.status === 'CANCELLED' || run.cancellationRequestedAt !== null
  })
}

export async function requestEvaluationRunCancellation(params: {
  runId: string
  tenantId: string
  venueId: string
  requestedBy: string
  requestedByRole: string
}): Promise<'requested' | 'already-requested' | 'terminal' | 'not-found'> {
  return withTenantIsolationBypass(() =>
    db.$transaction(async (tx) => {
      const run = await tx.evalRun.findFirst({
        where: { id: params.runId, tenantId: params.tenantId, venueId: params.venueId },
        select: { status: true, cancellationRequestedAt: true },
      })
      let outcome: 'requested' | 'already-requested' | 'terminal' | 'not-found'
      let afterStatus: string | null = run?.status ?? null
      if (!run) {
        outcome = 'not-found'
      } else if (run.cancellationRequestedAt) {
        outcome = 'already-requested'
      } else if (['LEGACY', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
        outcome = 'terminal'
      } else {
        const now = new Date()
        const result = await tx.evalRun.updateMany({
          where: {
            id: params.runId,
            tenantId: params.tenantId,
            venueId: params.venueId,
            status: run.status,
            cancellationRequestedAt: null,
          },
          data: {
            cancellationRequestedAt: now,
            cancellationRequestedBy: params.requestedBy,
            ...(['STAGED', 'QUEUED', 'RETRY_SCHEDULED'].includes(run.status)
              ? { status: 'CANCELLED', completedAt: now }
              : {}),
          },
        })
        if (result.count === 1) {
          outcome = 'requested'
          if (['STAGED', 'QUEUED', 'RETRY_SCHEDULED'].includes(run.status)) {
            afterStatus = 'CANCELLED'
          }
        } else {
          const raced = await tx.evalRun.findFirst({
            where: { id: params.runId, tenantId: params.tenantId, venueId: params.venueId },
            select: { status: true, cancellationRequestedAt: true },
          })
          if (!raced) outcome = 'not-found'
          else if (raced.cancellationRequestedAt) outcome = 'already-requested'
          else if (['LEGACY', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(raced.status)) {
            outcome = 'terminal'
          } else {
            throw new Error('Evaluation cancellation conflicted with another lifecycle transition')
          }
          afterStatus = raced?.status ?? null
        }
      }
      await writeAuditLogStrict(
        {
          tenantId: params.tenantId,
          actorId: params.requestedBy,
          actorRole: params.requestedByRole,
          action: `evaluation.run.cancellation-${outcome}`,
          targetType: 'EvalRun',
          targetId: params.runId,
          beforeState: {
            status: run?.status ?? null,
            cancellationRequested: run?.cancellationRequestedAt !== null && run !== null,
          },
          afterState: { status: afterStatus, outcome },
        },
        tx,
      )
      return outcome
    }),
  )
}
