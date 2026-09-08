import type { AiAdmissionGuard } from './admission'
import type { AiUsageSink } from './anthropic'
import type { AiBudgetGate, AiBudgetReservationRef } from './budget'
import { GuestWebSearchError, searchGuestWeb, type GuestWebSearchResult } from './guest-web-search'

export type GuestWebSearchPricing = {
  model: string
  version: string
  /** Reviewed upper bound for the complete provider invocation, not query size. */
  maximumInputTokens: number
  inputUnitsPerMillionTokens: bigint
  cachedInputUnitsPerMillionTokens: bigint
  outputUnitsPerMillionTokens: bigint
  toolCallUnits: bigint
}

/** One reserved provider dispatch; retries belong to the durable owning operation. */
export async function searchGuestWebWithAccounting(params: {
  request: Parameters<typeof searchGuestWeb>[0]
  pricing: GuestWebSearchPricing
  invocationId: string
  budgetGate: AiBudgetGate
  admissionGuard: AiAdmissionGuard
  beforeDispatch: () => Promise<void>
  usageSink: AiUsageSink
}): Promise<GuestWebSearchResult> {
  const { pricing, request, budgetGate } = params
  if (
    pricing.model !== request.model ||
    !pricing.version.trim() ||
    !params.invocationId.trim() ||
    !Number.isSafeInteger(pricing.maximumInputTokens) ||
    pricing.maximumInputTokens < 1 ||
    !Number.isSafeInteger(request.maxOutputTokens) ||
    request.maxOutputTokens < 1 ||
    request.maxToolCalls !== 1 ||
    pricing.inputUnitsPerMillionTokens < 0n ||
    pricing.cachedInputUnitsPerMillionTokens < 0n ||
    pricing.outputUnitsPerMillionTokens < 0n ||
    pricing.toolCallUnits < 0n ||
    pricing.cachedInputUnitsPerMillionTokens > pricing.inputUnitsPerMillionTokens
  )
    throw new Error('Invalid governed web-search pricing or request')
  const roundUnits = (value: bigint) => (value + 999_999n) / 1_000_000n
  const reservedUnits =
    roundUnits(
      BigInt(pricing.maximumInputTokens) * pricing.inputUnitsPerMillionTokens +
        BigInt(request.maxOutputTokens) * pricing.outputUnitsPerMillionTokens,
    ) + pricing.toolCallUnits
  let reservation: AiBudgetReservationRef | null = null
  let dispatched = false
  let settled = false
  const startedAt = performance.now()
  const settleObserved = async (
    result: Pick<GuestWebSearchResult, 'model' | 'usage'>,
    success: boolean,
    errorCode?: string,
  ) => {
    if (!reservation) throw new Error('Missing web search reservation')
    const cached = result.usage.cachedInputTokens
    if (
      result.usage.inputTokens > pricing.maximumInputTokens ||
      result.usage.outputTokens > request.maxOutputTokens ||
      result.usage.webSearchToolCalls !== 1 ||
      result.model !== pricing.model
    )
      throw new Error('Web search exceeded its reviewed pricing boundary')
    const actualUnits =
      roundUnits(
        BigInt(result.usage.inputTokens - cached) * pricing.inputUnitsPerMillionTokens +
          BigInt(cached) * pricing.cachedInputUnitsPerMillionTokens +
          BigInt(result.usage.outputTokens) * pricing.outputUnitsPerMillionTokens,
      ) + pricing.toolCallUnits
    await budgetGate.settleExact(reservation, actualUnits)
    settled = true
    await params.usageSink({
      provider: 'openai',
      model: result.model,
      pricingVersion: pricing.version,
      usage: {
        inputTokens: result.usage.inputTokens - cached,
        outputTokens: result.usage.outputTokens,
        cacheReadInputTokens: cached,
        cacheCreationInputTokens: 0,
      },
      estimatedCostUsd: Number(actualUnits) / 100_000_000,
      latencyMs: performance.now() - startedAt,
      attempts: 1,
      success,
      ...(errorCode ? { errorCode } : {}),
      capability: 'GENERAL_WEB_SEARCH',
      requestType: 'guest-general-web-search',
      usageObservationStatus: 'OBSERVED',
    })
  }
  try {
    await params.admissionGuard()
    reservation = await budgetGate.reserve({
      invocationId: params.invocationId,
      attemptNumber: 1,
      provider: 'openai',
      model: pricing.model,
      pricingVersion: pricing.version,
      reservedUnits,
    })
    // A missing durable reservation must not turn optional search into unmetered work.
    if (!reservation) throw new Error('Web search requires a durable cost reservation')
    await params.admissionGuard()
    await params.beforeDispatch()
    await budgetGate.markDispatched(reservation)
    dispatched = true
    const result = await searchGuestWeb(request)
    await settleObserved(result, true)
    return result
  } catch (error) {
    if (
      reservation &&
      !settled &&
      dispatched &&
      error instanceof GuestWebSearchError &&
      error.observedUsage
    ) {
      await settleObserved(error.observedUsage, false, error.code)
    }
    if (reservation && !settled) {
      if (dispatched) await budgetGate.settleAmbiguous(reservation)
      else await budgetGate.releaseUndispatched(reservation)
    }
    throw error
  }
}
