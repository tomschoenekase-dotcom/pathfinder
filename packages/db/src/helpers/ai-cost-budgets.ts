import type { AiCostReservation, AiCostSettlementKind } from '@prisma/client'

import type { db } from '../client'
import { publishOperationalEvent } from './operational-events'

export const AI_COST_BUDGET_COVERAGE_VERSION = 'gateway-v1'
export const AI_COST_RESERVATION_TTL_MS = 15 * 60 * 1_000

type BudgetClient = Pick<
  typeof db,
  '$transaction' | 'aiCostBudget' | 'aiCostReservation' | 'operationalEvent'
>

export type AiCostAttemptIdentity = {
  tenantId: string
  venueId: string | null
  invocationId: string
  attemptNumber: number
  feature: string
  provider: string
  model: string
  pricingVersion: string
}

export type AiCostReservationRef = AiCostAttemptIdentity & {
  id: string
  budgetId: string
  budgetEpoch: number
  reservedUnits: bigint
}

export class AiCostBudgetExceededError extends Error {
  constructor() {
    super('AI cost budget is exhausted')
    this.name = 'AiCostBudgetExceededError'
  }
}

export class AiCostBudgetUnavailableError extends Error {
  constructor(message = 'AI cost budget control is unavailable') {
    super(message)
    this.name = 'AiCostBudgetUnavailableError'
  }
}

export class AiCostBudgetInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiCostBudgetInvariantError'
  }
}

function assertIdentity(identity: AiCostAttemptIdentity): void {
  if (!identity.tenantId || identity.venueId === '' || !identity.invocationId) {
    throw new AiCostBudgetInvariantError('AI cost reservation identity is incomplete')
  }
  if (!Number.isInteger(identity.attemptNumber) || identity.attemptNumber < 1) {
    throw new AiCostBudgetInvariantError('AI cost reservation attempt number is invalid')
  }
  for (const value of [
    identity.feature,
    identity.provider,
    identity.model,
    identity.pricingVersion,
  ]) {
    if (!value.trim()) throw new AiCostBudgetInvariantError('AI cost reservation metadata is blank')
  }
}

function reservationRef(row: AiCostReservation): AiCostReservationRef {
  return {
    id: row.id,
    budgetId: row.budgetId,
    budgetEpoch: row.budgetEpoch,
    tenantId: row.tenantId,
    venueId: row.venueId,
    invocationId: row.invocationId,
    attemptNumber: row.attemptNumber,
    feature: row.feature,
    provider: row.provider,
    model: row.model,
    pricingVersion: row.pricingVersion,
    reservedUnits: row.reservedUnits,
  }
}

function sameReservation(
  row: AiCostReservation,
  identity: AiCostAttemptIdentity,
  reservedUnits: bigint,
): boolean {
  return (
    row.tenantId === identity.tenantId &&
    row.venueId === identity.venueId &&
    row.invocationId === identity.invocationId &&
    row.attemptNumber === identity.attemptNumber &&
    row.feature === identity.feature &&
    row.provider === identity.provider &&
    row.model === identity.model &&
    row.pricingVersion === identity.pricingVersion &&
    row.reservedUnits === reservedUnits
  )
}

async function publishCostProtectionEventBestEffort(params: {
  db: BudgetClient
  identity: Pick<AiCostAttemptIdentity, 'tenantId' | 'venueId' | 'feature'>
  kind: 'REQUEST_DENIED' | 'BUDGET_BREACHED'
}): Promise<void> {
  try {
    const budget = await params.db.aiCostBudget.findFirst({
      where: {
        tenantId: params.identity.tenantId,
        coverageVersion: AI_COST_BUDGET_COVERAGE_VERSION,
      },
      select: { id: true, epoch: true, breachedAt: true },
    })
    if (!budget) return
    const breached = budget.breachedAt !== null
    if (params.kind === 'BUDGET_BREACHED' && !breached) return
    await publishOperationalEvent({
      client: params.db,
      event: {
        tenantId: params.identity.tenantId,
        ...(params.identity.venueId !== null ? { venueId: params.identity.venueId } : {}),
        eventType: breached ? 'ai-cost-budget.breached' : 'ai-cost-budget.request-denied',
        sourceSubsystem: 'ai-cost-control',
        severity: 'ERROR',
        title: breached
          ? 'AI cost budget stopped new requests'
          : 'AI request reached its cost limit',
        summary: breached
          ? 'The configured tenant AI cost budget is breached and new covered requests are blocked.'
          : `A ${params.identity.feature} request was denied because its bounded reservation exceeded the configured tenant AI cost budget capacity.`,
        actionRequired: true,
        linkedObjectType: 'AiCostBudget',
        linkedObjectId: budget.id,
        recommendedAction:
          'Review tenant usage and reservation evidence. Reset or change the budget only after confirming the intended operating policy.',
        deduplicationKey: `ai-cost-budget:${breached ? 'breached' : 'denied'}:${budget.id}:${budget.epoch}`,
      },
    })
  } catch {
    // Cost enforcement is authoritative. An observability outage must not
    // reopen budget capacity or replace the original admission result.
  }
}

export async function reserveAiCostAttempt(params: {
  db: BudgetClient
  identity: AiCostAttemptIdentity
  reservedUnits: bigint
  reservationId: string
  now?: Date
}): Promise<AiCostReservationRef | null> {
  assertIdentity(params.identity)
  if (params.reservedUnits <= 0n) {
    throw new AiCostBudgetInvariantError('AI cost reservation must be positive')
  }
  const now = params.now ?? new Date()

  try {
    return await params.db.$transaction(async (tx) => {
      const budget = await tx.aiCostBudget.findFirst({
        where: {
          tenantId: params.identity.tenantId,
          coverageVersion: AI_COST_BUDGET_COVERAGE_VERSION,
        },
      })
      if (!budget || !budget.enabled) return null
      if (budget.breachedAt || now < budget.startsAt || now >= budget.endsAt) {
        throw new AiCostBudgetUnavailableError()
      }

      const existing = await tx.aiCostReservation.findFirst({
        where: {
          budgetId: budget.id,
          tenantId: params.identity.tenantId,
          budgetEpoch: budget.epoch,
          invocationId: params.identity.invocationId,
          attemptNumber: params.identity.attemptNumber,
        },
      })
      if (existing) {
        if (!sameReservation(existing, params.identity, params.reservedUnits)) {
          throw new AiCostBudgetInvariantError('AI cost reservation replay does not match')
        }
        if (existing.status !== 'RESERVED' || existing.dispatchStartedAt) {
          throw new AiCostBudgetInvariantError('AI cost reservation attempt was already dispatched')
        }
        return reservationRef(existing)
      }

      const reservation = await tx.aiCostReservation.create({
        data: {
          id: params.reservationId,
          budgetId: budget.id,
          tenantId: params.identity.tenantId,
          venueId: params.identity.venueId,
          budgetEpoch: budget.epoch,
          invocationId: params.identity.invocationId,
          attemptNumber: params.identity.attemptNumber,
          feature: params.identity.feature,
          provider: params.identity.provider,
          model: params.identity.model,
          pricingVersion: params.identity.pricingVersion,
          reservedUnits: params.reservedUnits,
          expiresAt: new Date(now.getTime() + AI_COST_RESERVATION_TTL_MS),
        },
      })
      const claimed = await tx.aiCostBudget.updateMany({
        where: {
          id: budget.id,
          tenantId: params.identity.tenantId,
          enabled: true,
          epoch: budget.epoch,
          revision: budget.revision,
          breachedAt: null,
          startsAt: { lte: now },
          endsAt: { gt: now },
          remainingUnits: { gte: params.reservedUnits },
        },
        data: {
          remainingUnits: { decrement: params.reservedUnits },
          reservedUnits: { increment: params.reservedUnits },
        },
      })
      if (claimed.count !== 1) throw new AiCostBudgetExceededError()
      return reservationRef(reservation)
    })
  } catch (error) {
    if (error instanceof AiCostBudgetExceededError) {
      await publishCostProtectionEventBestEffort({
        db: params.db,
        identity: params.identity,
        kind: 'REQUEST_DENIED',
      })
      throw error
    }
    if (error instanceof AiCostBudgetUnavailableError) {
      await publishCostProtectionEventBestEffort({
        db: params.db,
        identity: params.identity,
        kind: 'BUDGET_BREACHED',
      })
      throw error
    }
    if (!(error instanceof Object) || !('code' in error) || error.code !== 'P2002') throw error
    return params.db.$transaction(async (tx) => {
      const budget = await tx.aiCostBudget.findFirst({
        where: {
          tenantId: params.identity.tenantId,
          coverageVersion: AI_COST_BUDGET_COVERAGE_VERSION,
        },
      })
      if (!budget) throw new AiCostBudgetInvariantError('AI cost reservation budget disappeared')
      const existing = await tx.aiCostReservation.findFirst({
        where: {
          budgetId: budget.id,
          tenantId: params.identity.tenantId,
          budgetEpoch: budget.epoch,
          invocationId: params.identity.invocationId,
          attemptNumber: params.identity.attemptNumber,
        },
      })
      if (
        !existing ||
        !sameReservation(existing, params.identity, params.reservedUnits) ||
        existing.status !== 'RESERVED' ||
        existing.dispatchStartedAt
      ) {
        throw new AiCostBudgetInvariantError('AI cost reservation replay conflict')
      }
      return reservationRef(existing)
    })
  }
}

export async function markAiCostAttemptDispatched(params: {
  db: BudgetClient
  reservation: AiCostReservationRef
  now?: Date
}): Promise<void> {
  const now = params.now ?? new Date()
  const updated = await params.db.aiCostReservation.updateMany({
    where: {
      id: params.reservation.id,
      budgetId: params.reservation.budgetId,
      tenantId: params.reservation.tenantId,
      venueId: params.reservation.venueId,
      budgetEpoch: params.reservation.budgetEpoch,
      invocationId: params.reservation.invocationId,
      attemptNumber: params.reservation.attemptNumber,
      reservedUnits: params.reservation.reservedUnits,
      status: 'RESERVED',
      dispatchStartedAt: null,
    },
    data: { dispatchStartedAt: now },
  })
  if (updated.count !== 1) {
    throw new AiCostBudgetInvariantError('AI cost reservation dispatch fence was not acquired')
  }
}

async function resolveReservation(params: {
  db: BudgetClient
  reservation: AiCostReservationRef
  settledUnits: bigint
  kind: AiCostSettlementKind | null
  release: boolean
  now?: Date
}): Promise<void> {
  if (params.settledUnits < 0n) {
    throw new AiCostBudgetInvariantError('AI cost settlement must be nonnegative')
  }
  const now = params.now ?? new Date()
  const breachedBudget = await params.db.$transaction(async (tx) => {
    const current = await tx.aiCostReservation.findFirst({
      where: { id: params.reservation.id, tenantId: params.reservation.tenantId },
    })
    if (
      !current ||
      !sameReservation(current, params.reservation, params.reservation.reservedUnits)
    ) {
      throw new AiCostBudgetInvariantError('AI cost reservation identity changed')
    }
    if (current.status !== 'RESERVED') {
      const expectedStatus = params.release ? 'RELEASED' : 'SETTLED'
      if (
        current.status === expectedStatus &&
        current.settledUnits === params.settledUnits &&
        current.settlementKind === params.kind
      ) {
        return null
      }
      throw new AiCostBudgetInvariantError('AI cost reservation terminal replay does not match')
    }
    if (params.release && current.dispatchStartedAt) {
      throw new AiCostBudgetInvariantError('A dispatched AI cost reservation cannot be released')
    }
    if (!params.release && params.kind !== 'EXPIRED_MAX' && !current.dispatchStartedAt) {
      throw new AiCostBudgetInvariantError('An undispatched AI cost reservation cannot be settled')
    }

    const overage = params.settledUnits - current.reservedUnits
    const isOverCeiling = overage > 0n
    if (isOverCeiling && params.kind !== 'OVER_CEILING') {
      throw new AiCostBudgetInvariantError('AI cost settlement exceeded its reservation')
    }
    if (!isOverCeiling && params.kind === 'OVER_CEILING') {
      throw new AiCostBudgetInvariantError(
        'AI cost over-ceiling settlement is not over its reservation',
      )
    }

    const resolved = await tx.aiCostReservation.updateMany({
      where: { id: current.id, tenantId: current.tenantId, status: 'RESERVED' },
      data: {
        status: params.release ? 'RELEASED' : 'SETTLED',
        settledUnits: params.settledUnits,
        settlementKind: params.kind,
        resolvedAt: now,
      },
    })
    if (resolved.count !== 1) {
      throw new AiCostBudgetInvariantError('AI cost reservation lost its settlement fence')
    }

    if (params.release || !isOverCeiling) {
      const refundUnits = current.reservedUnits - params.settledUnits
      const budget = await tx.aiCostBudget.updateMany({
        where: {
          id: current.budgetId,
          tenantId: current.tenantId,
          epoch: current.budgetEpoch,
          reservedUnits: { gte: current.reservedUnits },
        },
        data: {
          reservedUnits: { decrement: current.reservedUnits },
          committedUnits: { increment: params.settledUnits },
          remainingUnits: { increment: refundUnits },
        },
      })
      if (budget.count !== 1) {
        throw new AiCostBudgetInvariantError('AI cost budget settlement counter update failed')
      }
      return null
    }

    const withCapacity = await tx.aiCostBudget.updateMany({
      where: {
        id: current.budgetId,
        tenantId: current.tenantId,
        epoch: current.budgetEpoch,
        breachedAt: null,
        reservedUnits: { gte: current.reservedUnits },
        remainingUnits: { gte: overage },
      },
      data: {
        reservedUnits: { decrement: current.reservedUnits },
        committedUnits: { increment: params.settledUnits },
        remainingUnits: { decrement: overage },
        breachedAt: now,
      },
    })
    if (withCapacity.count === 1) {
      return { id: current.budgetId, epoch: current.budgetEpoch }
    }

    const exhausted = await tx.aiCostBudget.updateMany({
      where: {
        id: current.budgetId,
        tenantId: current.tenantId,
        epoch: current.budgetEpoch,
        breachedAt: null,
        reservedUnits: { gte: current.reservedUnits },
        remainingUnits: { lt: overage },
      },
      data: {
        reservedUnits: { decrement: current.reservedUnits },
        committedUnits: { increment: params.settledUnits },
        remainingUnits: 0,
        breachedAt: now,
      },
    })
    if (exhausted.count !== 1) {
      throw new AiCostBudgetInvariantError('AI cost budget breach update failed')
    }
    return { id: current.budgetId, epoch: current.budgetEpoch }
  })
  if (breachedBudget) {
    await publishCostProtectionEventBestEffort({
      db: params.db,
      identity: {
        tenantId: params.reservation.tenantId,
        venueId: params.reservation.venueId,
        feature: params.reservation.feature,
      },
      kind: 'BUDGET_BREACHED',
    })
  }
}

export async function settleAiCostAttemptExact(params: {
  db: BudgetClient
  reservation: AiCostReservationRef
  settledUnits: bigint
  now?: Date
}): Promise<void> {
  await resolveReservation({
    ...params,
    kind: params.settledUnits > params.reservation.reservedUnits ? 'OVER_CEILING' : 'EXACT',
    release: false,
  })
}

export async function settleAiCostAttemptAmbiguous(params: {
  db: BudgetClient
  reservation: AiCostReservationRef
  now?: Date
}): Promise<void> {
  await resolveReservation({
    ...params,
    settledUnits: params.reservation.reservedUnits,
    kind: 'AMBIGUOUS_MAX',
    release: false,
  })
}

export async function releaseUndispatchedAiCostAttempt(params: {
  db: BudgetClient
  reservation: AiCostReservationRef
  now?: Date
}): Promise<void> {
  await resolveReservation({ ...params, settledUnits: 0n, kind: null, release: true })
}

export type ReconcileExpiredAiCostAttemptsResult = {
  scanned: number
  settled: number
  raced: number
}

/**
 * Conservatively resolves stale attempts at their full reserved ceiling. This
 * never reopens capacity: an expired attempt may have reached the provider
 * before its process died, even when the dispatch fence was not durably saved.
 */
export async function reconcileExpiredAiCostAttempts(params: {
  db: BudgetClient
  tenantId: string
  now?: Date
  limit?: number
}): Promise<ReconcileExpiredAiCostAttemptsResult> {
  if (!params.tenantId) {
    throw new AiCostBudgetInvariantError('Expired AI cost reconciliation requires a tenant')
  }
  const limit = params.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new AiCostBudgetInvariantError('Expired AI cost reconciliation limit is invalid')
  }
  const now = params.now ?? new Date()
  const expired = await params.db.aiCostReservation.findMany({
    where: {
      tenantId: params.tenantId,
      status: 'RESERVED',
      expiresAt: { lte: now },
    },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: limit,
  })

  let settled = 0
  let raced = 0
  for (const row of expired) {
    try {
      await resolveReservation({
        db: params.db,
        reservation: reservationRef(row),
        settledUnits: row.reservedUnits,
        kind: 'EXPIRED_MAX',
        release: false,
        now,
      })
      settled += 1
    } catch (error) {
      if (!(error instanceof AiCostBudgetInvariantError)) throw error
      const current = await params.db.aiCostReservation.findFirst({
        where: { id: row.id, tenantId: params.tenantId },
        select: { status: true },
      })
      if (current && current.status !== 'RESERVED') {
        raced += 1
        continue
      }
      throw error
    }
  }

  return { scanned: expired.length, settled, raced }
}
