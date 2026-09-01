import { randomUUID } from 'node:crypto'

import { type AiBudgetGate, type AiBudgetReservationRef, type AiUsageSink } from '@pathfinder/ai'
import { normalizeAiUsageErrorCode } from '@pathfinder/ai/usage-error-code'
import { logger } from '@pathfinder/config'
import {
  db,
  markAiCostAttemptDispatched,
  releaseUndispatchedAiCostAttempt,
  reserveAiCostAttempt,
  settleAiCostAttemptAmbiguous,
  settleAiCostAttemptExact,
  type AiCostReservationRef,
} from '@pathfinder/db'

export function createWorkerAiUsageSink(params: {
  tenantId: string
  venueId: string
  feature: string
}): AiUsageSink {
  return async (usage) => {
    try {
      const errorCode = normalizeAiUsageErrorCode(usage.errorCode)
      await db.aiUsageEvent.create({
        data: {
          tenantId: params.tenantId,
          venueId: params.venueId,
          feature: params.feature,
          capability: usage.capability ?? 'UNCLASSIFIED',
          ...(usage.requestType ? { requestType: usage.requestType } : {}),
          ...(usage.routeModelKey ? { routeModelKey: usage.routeModelKey } : {}),
          fallbackUsed: usage.fallbackUsed ?? false,
          surface: 'worker',
          provider: usage.provider,
          model: usage.model,
          pricingVersion: usage.pricingVersion,
          inputTokens: usage.usage.inputTokens,
          outputTokens: usage.usage.outputTokens,
          audioInputTokens: usage.usage.audioInputTokens ?? 0,
          audioOutputTokens: usage.usage.audioOutputTokens ?? 0,
          cachedAudioInputTokens: usage.usage.cachedAudioInputTokens ?? 0,
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
          ...(errorCode ? { errorCode } : {}),
        },
      })
    } catch {
      logger.error({
        action: 'workers.ai_usage.failed',
        tenantId: params.tenantId,
        venueId: params.venueId,
        feature: params.feature,
        error: 'AI usage persistence failed',
      })
    }
  }
}

export function createWorkerAiBudgetGate(params: {
  tenantId: string
  venueId: string
  feature: string
}): AiBudgetGate {
  const reservations = new Map<string, AiCostReservationRef>()
  const requireReservation = (ref: AiBudgetReservationRef): AiCostReservationRef => {
    const reservation = reservations.get(ref.id)
    if (!reservation || reservation.reservedUnits !== ref.reservedUnits) {
      throw new Error('AI cost reservation reference is unavailable')
    }
    return reservation
  }
  return {
    reserve: async (attempt) => {
      const reservation = await reserveAiCostAttempt({
        db,
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
      await markAiCostAttemptDispatched({ db, reservation: requireReservation(ref) })
    },
    settleExact: async (ref, actualUnits) => {
      await settleAiCostAttemptExact({
        db,
        reservation: requireReservation(ref),
        settledUnits: actualUnits,
      })
      reservations.delete(ref.id)
    },
    settleAmbiguous: async (ref) => {
      await settleAiCostAttemptAmbiguous({ db, reservation: requireReservation(ref) })
      reservations.delete(ref.id)
    },
    releaseUndispatched: async (ref) => {
      await releaseUndispatchedAiCostAttempt({
        db,
        reservation: requireReservation(ref),
      })
      reservations.delete(ref.id)
    },
  }
}
