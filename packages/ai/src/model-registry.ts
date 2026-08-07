export const AI_MODEL_KEYS = {
  ANALYTICS_TOPIC_CLASSIFIER: 'analytics-topic-classifier',
  ANALYTICS_WEEKLY_THEMES: 'analytics-weekly-themes',
  GUEST_CHAT: 'guest-chat',
} as const

export type AiModelKey = (typeof AI_MODEL_KEYS)[keyof typeof AI_MODEL_KEYS]

export type AiModelSpec = {
  provider: 'anthropic'
  model: string
  maxOutputTokens: number
  timeoutMs: number
  maxAttempts: number
  pricingVersion: string
  pricingUsdPerMillionTokens: {
    input: number
    output: number
    cacheWrite: number
    cacheRead: number
  }
}

const HAIKU_PRICING = {
  input: 1,
  output: 5,
  cacheWrite: 1.25,
  cacheRead: 0.1,
} as const

function haikuSpec(maxOutputTokens: number): AiModelSpec {
  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    maxOutputTokens,
    timeoutMs: 10_000,
    maxAttempts: 2,
    pricingVersion: 'anthropic-public-2026-08-07',
    // Anthropic Claude API list prices verified 2026-08-07. Keep pricing
    // versioned with code; cost is an estimate, never an invoice amount.
    pricingUsdPerMillionTokens: HAIKU_PRICING,
  }
}

export const AI_MODEL_REGISTRY: Readonly<Record<AiModelKey, AiModelSpec>> = {
  [AI_MODEL_KEYS.ANALYTICS_TOPIC_CLASSIFIER]: haikuSpec(1_024),
  [AI_MODEL_KEYS.ANALYTICS_WEEKLY_THEMES]: haikuSpec(1_024),
  [AI_MODEL_KEYS.GUEST_CHAT]: haikuSpec(512),
}

export function getAiModelSpec(modelKey: AiModelKey): AiModelSpec {
  return AI_MODEL_REGISTRY[modelKey]
}
