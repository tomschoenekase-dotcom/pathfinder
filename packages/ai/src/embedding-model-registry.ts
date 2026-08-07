export const AI_EMBEDDING_MODEL_KEYS = {
  GUEST_QUERY: 'guest-query-embedding',
} as const

export type AiEmbeddingModelKey =
  (typeof AI_EMBEDDING_MODEL_KEYS)[keyof typeof AI_EMBEDDING_MODEL_KEYS]

export type AiEmbeddingModelSpec = {
  provider: 'openai'
  model: string
  dimensions: number
  timeoutMs: number
  maxAttempts: number
  pricingVersion: string
  inputUsdPerMillionTokens: number
}

export const AI_EMBEDDING_MODEL_REGISTRY: Readonly<
  Record<AiEmbeddingModelKey, AiEmbeddingModelSpec>
> = {
  [AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY]: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions: 1_536,
    timeoutMs: 10_000,
    maxAttempts: 2,
    pricingVersion: 'openai-public-2026-08-07',
    // OpenAI public model pricing verified 2026-08-07. This is an
    // estimate for operating evidence, not an invoice amount.
    inputUsdPerMillionTokens: 0.02,
  },
}

export function getAiEmbeddingModelSpec(modelKey: AiEmbeddingModelKey): AiEmbeddingModelSpec {
  return AI_EMBEDDING_MODEL_REGISTRY[modelKey]
}
