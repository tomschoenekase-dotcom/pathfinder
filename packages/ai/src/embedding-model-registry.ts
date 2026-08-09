export const AI_EMBEDDING_MODEL_KEYS = {
  GUEST_QUERY: 'guest-query-embedding',
  PLACE_CONTENT: 'place-content-embedding',
  KNOWLEDGE_CONTENT: 'knowledge-content-embedding',
  ANALYTICS_CLUSTERING: 'analytics-clustering-embedding',
} as const

export type AiEmbeddingModelKey =
  (typeof AI_EMBEDDING_MODEL_KEYS)[keyof typeof AI_EMBEDDING_MODEL_KEYS]

export type AiEmbeddingModelSpec = {
  provider: 'openai'
  model: string
  dimensions: number
  timeoutMs: number
  maxAttempts: number
  maxInputUtf8Bytes: number
  maxBillableInputTokens: number
  pricingVersion: string
  inputUsdPerMillionTokens: number
}

const TEXT_EMBEDDING_3_SMALL = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1_536,
  timeoutMs: 10_000,
  pricingVersion: 'openai-public-2026-08-07',
  // OpenAI public model pricing verified 2026-08-07. This is an
  // estimate for operating evidence, not an invoice amount.
  inputUsdPerMillionTokens: 0.02,
  maxInputUtf8Bytes: 280_000,
  maxBillableInputTokens: 300_000,
} as const

export const AI_EMBEDDING_MODEL_REGISTRY: Readonly<
  Record<AiEmbeddingModelKey, AiEmbeddingModelSpec>
> = {
  [AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY]: {
    ...TEXT_EMBEDDING_3_SMALL,
    maxAttempts: 2,
  },
  [AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT]: {
    ...TEXT_EMBEDDING_3_SMALL,
    // BullMQ owns retries for worker jobs; do not multiply provider calls.
    maxAttempts: 1,
  },
  [AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT]: {
    ...TEXT_EMBEDDING_3_SMALL,
    // BullMQ owns retries for worker jobs; do not multiply provider calls.
    maxAttempts: 1,
  },
  [AI_EMBEDDING_MODEL_KEYS.ANALYTICS_CLUSTERING]: {
    ...TEXT_EMBEDDING_3_SMALL,
    // BullMQ owns retries for worker jobs; do not multiply provider calls.
    maxAttempts: 1,
  },
}

export function getAiEmbeddingModelSpec(modelKey: AiEmbeddingModelKey): AiEmbeddingModelSpec {
  return AI_EMBEDDING_MODEL_REGISTRY[modelKey]
}

export function getAiEmbeddingProfile(modelKey: AiEmbeddingModelKey): string {
  const spec = getAiEmbeddingModelSpec(modelKey)
  return `${spec.provider}:${spec.model}:${spec.dimensions}`
}
