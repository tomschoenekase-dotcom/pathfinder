import { z } from 'zod'

import {
  AI_CENTRAL_MODEL_REGISTRY,
  type AiCentralModel,
  type AiEffectiveWorkloadConfiguration,
  type AiProviderId,
  type AiWorkloadId,
} from './workload-configuration'

export const AI_CAPABILITIES = [
  'FAST',
  'STANDARD',
  'REASONING',
  'PREMIUM_CONVERSATION',
  'REALTIME_VOICE',
  'REALTIME_VOICE_ECONOMY',
  'EXTRACTION',
  'CLASSIFICATION',
  'EMBEDDING',
  'MODERATION',
  'BACKGROUND_ANALYSIS',
] as const

export const AiCapability = z.enum(AI_CAPABILITIES)
export type AiCapability = z.infer<typeof AiCapability>

export const AI_WORKLOAD_CAPABILITIES = Object.freeze({
  'agent-run': ['REASONING'],
  'analytics-topic-classifier': ['CLASSIFICATION'],
  'analytics-weekly-themes': ['BACKGROUND_ANALYSIS'],
  'answer-analysis': ['EXTRACTION', 'BACKGROUND_ANALYSIS'],
  'client-tochi': ['FAST'],
  'guest-chat': ['STANDARD', 'PREMIUM_CONVERSATION'],
  'weekly-digest': ['BACKGROUND_ANALYSIS'],
  'weekly-report': ['BACKGROUND_ANALYSIS'],
  'guest-query-embedding': ['EMBEDDING'],
  'place-content-embedding': ['EMBEDDING'],
  'knowledge-content-embedding': ['EMBEDDING'],
  'analytics-clustering-embedding': ['EMBEDDING'],
} as const satisfies Readonly<Record<AiWorkloadId, readonly AiCapability[]>>)

export type AiRouteCandidate = {
  modelKey: AiWorkloadId
  provider: AiProviderId
  model: string
  costTier: AiCentralModel['costTier']
  fallback: boolean
}

export type AiRoutePlan = {
  capability: AiCapability
  workloadId: AiWorkloadId
  candidates: AiRouteCandidate[]
  latencyPreference: 'LOW' | 'BALANCED'
  qualityPreference: 'ECONOMY' | 'BALANCED' | 'PREMIUM'
  configurationVersion: string
}

export type AiRoutingErrorCode =
  | 'CAPABILITY_MISMATCH'
  | 'CAPABILITY_NOT_ENTITLED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'NO_HEALTHY_ROUTE'

export class AiRoutingError extends Error {
  constructor(
    readonly code: AiRoutingErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AiRoutingError'
  }
}

function requiresPremiumEntitlement(capability: AiCapability): boolean {
  return capability === 'PREMIUM_CONVERSATION' || capability === 'REALTIME_VOICE'
}

function preferredOrder(
  candidates: AiRouteCandidate[],
  preference: AiRoutePlan['qualityPreference'],
): AiRouteCandidate[] {
  if (preference === 'BALANCED') return candidates
  const desired = preference === 'ECONOMY' ? 'ECONOMY' : 'PREMIUM'
  return [...candidates].sort((left, right) => {
    const leftRank = left.costTier === desired ? 0 : 1
    const rightRank = right.costTier === desired ? 0 : 1
    return leftRank - rightRank
  })
}

/**
 * Produces a provider-neutral, ordered route plan. Callers name the capability
 * they need; workload IDs identify request/prompt policy and are not model IDs.
 */
export function routeAiCapability(params: {
  capability: AiCapability
  workloadId: AiWorkloadId
  configuration: AiEffectiveWorkloadConfiguration
  premiumEntitled?: boolean
  capabilityAvailable?: boolean
  disabledProviders?: readonly AiProviderId[]
  disabledModels?: readonly string[]
  unhealthyProviders?: readonly AiProviderId[]
  budgetPolicy?: 'NORMAL' | 'ECONOMY_ONLY' | 'PREMIUM_ONLY'
  latencyPreference?: 'LOW' | 'BALANCED'
  qualityPreference?: 'ECONOMY' | 'BALANCED' | 'PREMIUM'
}): AiRoutePlan {
  const capability = AiCapability.parse(params.capability)
  if (!AI_WORKLOAD_CAPABILITIES[params.workloadId].includes(capability as never)) {
    throw new AiRoutingError(
      'CAPABILITY_MISMATCH',
      `${params.workloadId} is not registered for ${capability}`,
    )
  }
  if (params.capabilityAvailable === false) {
    throw new AiRoutingError('CAPABILITY_UNAVAILABLE', `${capability} is disabled`)
  }
  if (requiresPremiumEntitlement(capability) && params.premiumEntitled !== true) {
    throw new AiRoutingError('CAPABILITY_NOT_ENTITLED', `${capability} is not entitled`)
  }

  const keys = [
    params.configuration.primaryModelKey,
    ...(params.configuration.fallback.enabled ? params.configuration.fallback.modelKeys : []),
  ]
  const uniqueKeys = [...new Set(keys)]
  let candidates = uniqueKeys.map((modelKey, index) => {
    const model = AI_CENTRAL_MODEL_REGISTRY[modelKey]
    if (!model) throw new AiRoutingError('NO_HEALTHY_ROUTE', `Unknown route model ${modelKey}`)
    if (model.kind !== params.configuration.kind) {
      throw new AiRoutingError('NO_HEALTHY_ROUTE', 'Route candidate changed model kind')
    }
    return {
      modelKey,
      provider: model.provider,
      model: model.model,
      costTier: model.costTier,
      fallback: index > 0,
    }
  })

  const blockedProviders = new Set([
    ...(params.disabledProviders ?? []),
    ...(params.unhealthyProviders ?? []),
  ])
  const blockedModels = new Set(params.disabledModels ?? [])
  candidates = candidates.filter(
    (candidate) => !blockedProviders.has(candidate.provider) && !blockedModels.has(candidate.model),
  )

  if (params.budgetPolicy === 'ECONOMY_ONLY') {
    candidates = candidates.filter((candidate) => candidate.costTier === 'ECONOMY')
  } else if (params.budgetPolicy === 'PREMIUM_ONLY') {
    candidates = candidates.filter((candidate) => candidate.costTier === 'PREMIUM')
  }
  candidates = preferredOrder(candidates, params.qualityPreference ?? 'BALANCED')
  if (candidates.length === 0) {
    throw new AiRoutingError('NO_HEALTHY_ROUTE', `No healthy ${capability} route is available`)
  }

  return {
    capability,
    workloadId: params.workloadId,
    candidates,
    latencyPreference: params.latencyPreference ?? 'BALANCED',
    qualityPreference: params.qualityPreference ?? 'BALANCED',
    configurationVersion: params.configuration.configurationVersion,
  }
}
