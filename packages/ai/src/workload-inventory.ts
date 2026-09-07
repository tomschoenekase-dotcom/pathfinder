import {
  AI_CENTRAL_MODEL_REGISTRY,
  AI_PROVIDER_REGISTRY,
  type AiProviderId,
} from './workload-configuration'

export type AiProviderConfigurationState = 'CONFIGURED' | 'UNCONFIGURED' | 'UNKNOWN'

/** Read-only inventory. Registry prices are planning estimates, never observed spend or invoices. */
export function buildAiWorkloadInventory(
  providerConfigured: Partial<Record<AiProviderId, boolean>> = {},
) {
  return Object.values(AI_CENTRAL_MODEL_REGISTRY).map((model) => {
    const configured = providerConfigured[model.provider]
    const adapterSupportsKind = AI_PROVIDER_REGISTRY[model.provider].capabilities.includes(
      model.kind as never,
    )
    return {
      workloadId: model.key,
      kind: model.kind,
      provider: model.provider,
      model: model.model,
      adapterCallable: adapterSupportsKind,
      providerConfiguration:
        configured === undefined ? 'UNKNOWN' : configured ? 'CONFIGURED' : 'UNCONFIGURED',
      limits: model.limits,
      configuredPricingEstimate: {
        version: model.pricingVersion,
        usdPerMillionTokens: model.pricingUsdPerMillionTokens,
      },
      measured: { latencyMs: null, estimatedCostUsd: null, invoiceCostUsd: null },
    }
  })
}

export const AI_INVENTORY_OMISSIONS = Object.freeze([
  'realtime voice uses its dedicated route registry',
  'video/media analysis uses its dedicated provider budget',
  'character generation has no centrally registered model route',
])
