import { randomUUID } from 'node:crypto'

import type { AiBudgetGate, AiBudgetReservationRef, AiUsageSink } from '@pathfinder/ai'
import { logger } from '@pathfinder/config'
import {
  markAiCostAttemptDispatched,
  releaseUndispatchedAiCostAttempt,
  reserveAiCostAttempt,
  settleAiCostAttemptAmbiguous,
  settleAiCostAttemptExact,
  type AiCostReservationRef,
} from '@pathfinder/db'

import type { TRPCContext } from '../context'

export function createApiAiUsageRecorder(params: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  sessionId?: string
  feature: string
  surface: string
}) {
  const usageEventIds: string[] = []
  let persistenceFailed = false

  const sink: AiUsageSink = async (usage) => {
    try {
      const event = await params.db.aiUsageEvent.create({
        data: {
          tenantId: params.tenantId,
          venueId: params.venueId,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          feature: params.feature,
          surface: params.surface,
          provider: usage.provider,
          model: usage.model,
          pricingVersion: usage.pricingVersion,
          inputTokens: usage.usage.inputTokens,
          outputTokens: usage.usage.outputTokens,
          cacheCreationInputTokens: usage.usage.cacheCreationInputTokens,
          cacheReadInputTokens: usage.usage.cacheReadInputTokens,
          totalTokens:
            usage.usage.inputTokens +
            usage.usage.outputTokens +
            usage.usage.cacheCreationInputTokens +
            usage.usage.cacheReadInputTokens,
          estimatedCostUsd: usage.estimatedCostUsd,
          latencyMs: usage.latencyMs,
          attempts: usage.attempts,
          success: usage.success,
          ...(usage.errorCode ? { errorCode: usage.errorCode } : {}),
        },
        select: { id: true },
      })
      usageEventIds.push(event.id)
    } catch {
      persistenceFailed = true
      logger.error({
        action: 'api.ai_usage.persistence_failed',
        tenantId: params.tenantId,
        venueId: params.venueId,
        feature: params.feature,
        error: 'AI usage persistence failed',
      })
      throw new Error('AI usage persistence failed')
    }
  }

  const reservations = new Map<string, AiCostReservationRef>()
  const requireReservation = (ref: AiBudgetReservationRef): AiCostReservationRef => {
    const reservation = reservations.get(ref.id)
    if (!reservation || reservation.reservedUnits !== ref.reservedUnits) {
      throw new Error('AI cost reservation reference is unavailable')
    }
    return reservation
  }
  const budgetGate: AiBudgetGate = {
    reserve: async (attempt) => {
      const reservation = await reserveAiCostAttempt({
        db: params.db,
        identity: {
          tenantId: params.tenantId,
          venueId: params.venueId,
          invocationId: attempt.invocationId,
          attemptNumber: attempt.attemptNumber,
          feature: params.feature,
          provider: attempt.provider,
          model: attempt.model,
          pricingVersion: attempt.pricingVersion,
        },
        reservedUnits: attempt.reservedUnits,
        reservationId: randomUUID(),
      })
      if (!reservation) return null
      reservations.set(reservation.id, reservation)
      return { id: reservation.id, reservedUnits: reservation.reservedUnits }
    },
    markDispatched: async (ref) => {
      await markAiCostAttemptDispatched({ db: params.db, reservation: requireReservation(ref) })
    },
    settleExact: async (ref, actualUnits) => {
      await settleAiCostAttemptExact({
        db: params.db,
        reservation: requireReservation(ref),
        settledUnits: actualUnits,
      })
    },
    settleAmbiguous: async (ref) => {
      await settleAiCostAttemptAmbiguous({
        db: params.db,
        reservation: requireReservation(ref),
      })
    },
    releaseUndispatched: async (ref) => {
      await releaseUndispatchedAiCostAttempt({
        db: params.db,
        reservation: requireReservation(ref),
      })
    },
  }

  return {
    sink,
    budgetGate,
    usageEventIds: () => [...usageEventIds],
    persistenceFailed: () => persistenceFailed,
  }
}
