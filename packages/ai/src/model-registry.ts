export const AI_MODEL_KEYS = {
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

export const AI_MODEL_REGISTRY: Readonly<Record<AiModelKey, AiModelSpec>> = {
  [AI_MODEL_KEYS.GUEST_CHAT]: {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    maxOutputTokens: 512,
    timeoutMs: 10_000,
    maxAttempts: 2,
    pricingVersion: 'anthropic-public-2026-08-07',
    // Anthropic Claude API list prices verified 2026-08-07. Keep pricing
    // versioned with code; cost is an estimate, never an invoice amount.
    pricingUsdPerMillionTokens: {
      input: 1,
      output: 5,
      cacheWrite: 1.25,
      cacheRead: 0.1,
    },
  },
}

export function getAiModelSpec(modelKey: AiModelKey): AiModelSpec {
  return AI_MODEL_REGISTRY[modelKey]
}
