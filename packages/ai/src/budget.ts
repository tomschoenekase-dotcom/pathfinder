import { randomUUID } from 'node:crypto'

import type { AiMessage, AiSystemBlock } from './anthropic'
import type { AiEmbeddingModelSpec } from './embedding-model-registry'
import type { AiModelSpec } from './model-registry'

export type AiBudgetReservationRef = {
  id: string
  reservedUnits: bigint
}

export type AiBudgetAttempt = {
  invocationId: string
  attemptNumber: number
  provider: 'anthropic' | 'openai'
  model: string
  pricingVersion: string
  reservedUnits: bigint
}

export type AiBudgetGate = {
  reserve(attempt: AiBudgetAttempt): Promise<AiBudgetReservationRef | null>
  markDispatched(reservation: AiBudgetReservationRef): Promise<void>
  settleExact(reservation: AiBudgetReservationRef, actualUnits: bigint): Promise<void>
  settleAmbiguous(reservation: AiBudgetReservationRef): Promise<void>
  releaseUndispatched(reservation: AiBudgetReservationRef): Promise<void>
}

export const NOOP_AI_BUDGET_GATE: AiBudgetGate = {
  reserve: async () => null,
  markDispatched: async () => undefined,
  settleExact: async () => undefined,
  settleAmbiguous: async () => undefined,
  releaseUndispatched: async () => undefined,
}

export function createAiInvocationId(): string {
  return randomUUID()
}

function priceUnitsPerToken(usdPerMillionTokens: number): bigint {
  const units = usdPerMillionTokens * 100
  if (!Number.isSafeInteger(units) || units < 0) {
    throw new Error('AI registry pricing must resolve to exact 1e-8 USD units per token')
  }
  return BigInt(units)
}

export function textAttemptCostCeilingUnits(params: {
  spec: AiModelSpec
  system: AiSystemBlock[]
  messages: AiMessage[]
  maxOutputTokens: number
}): bigint {
  const inputBytes = Buffer.byteLength(
    JSON.stringify({ system: params.system, messages: params.messages }),
    'utf8',
  )
  if (inputBytes > params.spec.maxInputUtf8Bytes) {
    throw new Error('AI text request exceeds the verified budget input boundary')
  }
  if (
    !Number.isInteger(params.maxOutputTokens) ||
    params.maxOutputTokens < 1 ||
    params.maxOutputTokens > params.spec.maxOutputTokens
  ) {
    throw new Error('AI text request exceeds the registered output boundary')
  }
  const inputRate = Math.max(
    params.spec.pricingUsdPerMillionTokens.input,
    params.spec.pricingUsdPerMillionTokens.cacheWrite,
    params.spec.pricingUsdPerMillionTokens.cacheRead,
  )
  return (
    BigInt(params.spec.maxBillableInputTokens) * priceUnitsPerToken(inputRate) +
    BigInt(params.maxOutputTokens) *
      priceUnitsPerToken(params.spec.pricingUsdPerMillionTokens.output)
  )
}

export function embeddingAttemptCostCeilingUnits(params: {
  spec: AiEmbeddingModelSpec
  texts: string[]
}): bigint {
  const inputBytes = params.texts.reduce(
    (total, value) => total + Buffer.byteLength(value, 'utf8'),
    0,
  )
  if (inputBytes > params.spec.maxInputUtf8Bytes) {
    throw new Error('AI embedding request exceeds the verified budget input boundary')
  }
  return (
    BigInt(params.spec.maxBillableInputTokens) *
    priceUnitsPerToken(params.spec.inputUsdPerMillionTokens)
  )
}

export function observedAiCostUnits(estimatedCostUsd: number): bigint {
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
    throw new Error('Observed AI cost must be a nonnegative finite number')
  }
  const scaled = estimatedCostUsd * 100_000_000
  const nearest = Math.round(scaled)
  if (Math.abs(scaled - nearest) < 1e-6) return BigInt(nearest)
  return BigInt(Math.ceil(scaled))
}
