import type { EvalRunCostReservation } from '@prisma/client'

import type { db } from '../client'
import { createOrReplayEvaluationResult, type EvaluationResultTerminal } from './evaluation-results'

type CostClient = Pick<typeof db, '$transaction' | 'evalRun' | 'evalRunCostReservation'>

export class EvaluationRunCostReservationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvaluationRunCostReservationError'
  }
}

export type EvaluationRunCostReservationAcquisition =
  | { state: 'reserved'; reservation: EvalRunCostReservation }
  | { state: 'ambiguous'; reservation: EvalRunCostReservation }
  | { state: 'budget-blocked' }

function uniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

export async function reserveEvaluationRunCaseCost(params: {
  db: CostClient
  tenantId: string
  venueId: string
  runId: string
  runIdentityHash: string
  caseId: string
  caseRevision: number
  caseHash: string
  attemptNumber: number
  leaseToken: string
  reservedCostE8Usd: bigint
}): Promise<EvaluationRunCostReservationAcquisition> {
  if (
    params.reservedCostE8Usd < 0n ||
    !Number.isInteger(params.attemptNumber) ||
    params.attemptNumber < 1
  ) {
    throw new EvaluationRunCostReservationError(
      'Invalid evaluation cost reservation amount or attempt',
    )
  }
  const scope = {
    tenantId: params.tenantId,
    venueId: params.venueId,
    runId: params.runId,
    caseId: params.caseId,
    caseRevision: params.caseRevision,
  }
  const acquire = () =>
    params.db.$transaction(async (tx) => {
      const existing = await tx.evalRunCostReservation.findFirst({ where: scope })
      if (existing) {
        if (
          existing.runIdentityHash !== params.runIdentityHash ||
          existing.caseHash !== params.caseHash ||
          existing.reservedCostE8Usd < 0n
        )
          throw new EvaluationRunCostReservationError('Existing reservation identity mismatch')
        // RESERVED means a previous process may have reached the provider. It is
        // deliberately retained and must never authorize another dispatch.
        if (existing.status === 'RESERVED')
          return { state: 'ambiguous' as const, reservation: existing }
        throw new EvaluationRunCostReservationError(
          'Terminal reservation exists without terminal result',
        )
      }
      const run = await tx.evalRun.findFirst({
        where: {
          id: params.runId,
          tenantId: params.tenantId,
          venueId: params.venueId,
          identityHash: params.runIdentityHash,
          status: 'RUNNING',
          attemptNumber: params.attemptNumber,
          cancellationRequestedAt: null,
          executionLeaseToken: params.leaseToken,
          executionLeaseExpiresAt: { gt: new Date() },
        },
        select: { declaredBudgetCeilingE8Usd: true, budgetAccountedE8Usd: true },
      })
      if (!run)
        throw new EvaluationRunCostReservationError('Run is not owned by this exact attempt')
      if (params.reservedCostE8Usd > run.declaredBudgetCeilingE8Usd - run.budgetAccountedE8Usd) {
        return { state: 'budget-blocked' as const }
      }
      const advanced = await tx.evalRun.updateMany({
        where: {
          id: params.runId,
          tenantId: params.tenantId,
          venueId: params.venueId,
          identityHash: params.runIdentityHash,
          status: 'RUNNING',
          attemptNumber: params.attemptNumber,
          cancellationRequestedAt: null,
          executionLeaseToken: params.leaseToken,
          executionLeaseExpiresAt: { gt: new Date() },
          budgetAccountedE8Usd: { lte: run.declaredBudgetCeilingE8Usd - params.reservedCostE8Usd },
        },
        data: { budgetAccountedE8Usd: { increment: params.reservedCostE8Usd } },
      })
      if (advanced.count !== 1)
        throw new EvaluationRunCostReservationError('Concurrent budget reservation conflict')
      const reservation = await tx.evalRunCostReservation.create({
        data: {
          tenantId: params.tenantId,
          venueId: params.venueId,
          runId: params.runId,
          runIdentityHash: params.runIdentityHash,
          caseId: params.caseId,
          caseRevision: params.caseRevision,
          caseHash: params.caseHash,
          attemptNumber: params.attemptNumber,
          leaseToken: params.leaseToken,
          reservedCostE8Usd: params.reservedCostE8Usd,
        },
      })
      return { state: 'reserved' as const, reservation }
    })
  try {
    return await acquire()
  } catch (error) {
    if (!uniqueConflict(error)) throw error
    const existing = await params.db.evalRunCostReservation.findFirst({ where: scope })
    if (
      !existing ||
      existing.runIdentityHash !== params.runIdentityHash ||
      existing.caseHash !== params.caseHash
    ) {
      throw new EvaluationRunCostReservationError(
        'Reservation race did not resolve to exact identity',
      )
    }
    return { state: 'ambiguous', reservation: existing }
  }
}

export async function persistEvaluationResultWithCostReservation(params: {
  db: CostClient
  resultId: string
  reservationId: string
  tenantId: string
  venueId: string
  runId: string
  runIdentityHash: string
  evalCaseId: string
  caseRevision: number
  latencyMs: number
  costE8Usd: bigint
  terminal: EvaluationResultTerminal
  settlement: 'exact' | 'ambiguous'
  attemptNumber: number
  leaseToken: string
}): Promise<void> {
  await params.db.$transaction(async (tx) => {
    const fenced = await tx.evalRun.updateMany({
      where: {
        id: params.runId,
        identityHash: params.runIdentityHash,
        tenantId: params.tenantId,
        venueId: params.venueId,
        status: 'RUNNING',
        attemptNumber: params.attemptNumber,
        executionLeaseToken: params.leaseToken,
        executionLeaseExpiresAt: { gt: new Date() },
        cancellationRequestedAt: null,
      },
      data: { lastErrorCode: null },
    })
    if (fenced.count !== 1)
      throw new EvaluationRunCostReservationError('Evaluation result lease is stale')
    const { evalResult } = await createOrReplayEvaluationResult({ ...params, db: tx })
    const advanced = await tx.evalRunCostReservation.updateMany({
      where: {
        id: params.reservationId,
        tenantId: params.tenantId,
        venueId: params.venueId,
        runId: params.runId,
        caseId: params.evalCaseId,
        caseRevision: params.caseRevision,
        status: 'RESERVED',
      },
      data:
        params.settlement === 'exact'
          ? {
              status: 'SETTLED',
              settledCostE8Usd: params.costE8Usd,
              resultId: evalResult.id,
              settledAt: new Date(),
            }
          : { status: 'AMBIGUOUS', resultId: evalResult.id, settledAt: new Date() },
    })
    if (advanced.count !== 1) {
      const replay = await tx.evalRunCostReservation.findFirst({
        where: { id: params.reservationId, tenantId: params.tenantId, venueId: params.venueId },
      })
      const expectedStatus = params.settlement === 'exact' ? 'SETTLED' : 'AMBIGUOUS'
      if (!replay || replay.status !== expectedStatus || replay.resultId !== evalResult.id) {
        throw new EvaluationRunCostReservationError('Reservation settlement conflict')
      }
    }
  })
}

export async function persistEvaluationResultWithLease(params: {
  db: CostClient
  resultId: string
  tenantId: string
  venueId: string
  runId: string
  runIdentityHash: string
  evalCaseId: string
  caseRevision: number
  latencyMs: number
  costE8Usd: bigint
  terminal: EvaluationResultTerminal
  attemptNumber: number
  leaseToken: string
}): Promise<void> {
  await params.db.$transaction(async (tx) => {
    const fenced = await tx.evalRun.updateMany({
      where: {
        id: params.runId,
        identityHash: params.runIdentityHash,
        tenantId: params.tenantId,
        venueId: params.venueId,
        status: 'RUNNING',
        attemptNumber: params.attemptNumber,
        executionLeaseToken: params.leaseToken,
        executionLeaseExpiresAt: { gt: new Date() },
        cancellationRequestedAt: null,
      },
      data: { lastErrorCode: null },
    })
    if (fenced.count !== 1)
      throw new EvaluationRunCostReservationError('Evaluation result lease is stale')
    await createOrReplayEvaluationResult({ ...params, db: tx })
  })
}
