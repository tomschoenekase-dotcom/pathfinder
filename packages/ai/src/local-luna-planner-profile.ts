import type { AiModelSpec } from './model-registry'

/** Server-only, invocation-local planner experiment. Never a model/route registry override. */
export type LocalLunaPlannerProfile = 'LOCAL_LUNA_STANDARD_V1' | 'LOCAL_LUNA_FAST_V1'
export type LocalLunaTierReceipt = {
  profile: LocalLunaPlannerProfile
  requestedTier: 'default' | 'fast'
  observedTier: string | null
  providerResponseId: string | null
  sdkRequestSha256: string
  sdkRequestUtf8Bytes: number
  wireBoundary: 'SDK_PARAMS_JSON_NOT_OBSERVED_HTTP'
  costObservationStatus: 'OBSERVED' | 'UNKNOWN'
  rateMultiplier: 1 | 2 | null
  outcome: 'STANDARD_SERVED' | 'FAST_SERVED' | 'STANDARD_DOWNGRADE' | 'UNEXPECTED_FAST_TIER' | 'UNKNOWN_TIER'
}
export class LocalLunaPlannerExecutionError extends Error {
  constructor(readonly code: 'UNKNOWN_SERVICE_TIER' | 'PLANNER_ACCOUNTING_FAILED' | 'MISSING_PROVIDER_RESPONSE_ID' | 'UNEXPECTED_FAST_TIER' | 'INVALID_PLANNER_USAGE' | 'PLANNER_OPERATION_FAILED') {
    super(code)
    this.name = 'LocalLunaPlannerExecutionError'
  }
}
export function assertLocalLunaPlannerProfile(profile: unknown, spec: AiModelSpec, options: { maxAttempts: number; maxOutputTokens: number; streaming: boolean; explicitCache?: boolean }) {
  if (profile !== 'LOCAL_LUNA_STANDARD_V1' && profile !== 'LOCAL_LUNA_FAST_V1') throw new Error('Unsupported local planner invocation profile')
  const p = spec.pricingUsdPerMillionTokens
  if (spec.provider !== 'openai' || spec.model !== 'gpt-6-luna' || options.maxAttempts !== 1 || options.streaming || options.explicitCache || !Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > 1024 || options.maxOutputTokens > spec.maxOutputTokens || spec.maxBillableInputTokens !== 200_000 || spec.maxInputUtf8Bytes !== 180_000 || spec.pricingVersion !== 'openai-standard-public-2026-09-22' || p.input !== .1 || p.output !== .5 || p.cacheWrite !== .125 || p.cacheRead !== .01)
    throw new Error('Local planner profile requires the pinned compatible single-attempt nonstream Luna boundary')
}
export function localLunaPricingVersion(base: string, profile: LocalLunaPlannerProfile, observed: string = 'reserved-max2x') {
  return `${base}:local-${profile === 'LOCAL_LUNA_FAST_V1' ? 'fast' : 'standard'}-v1:${observed}`
}
