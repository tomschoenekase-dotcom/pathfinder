import { describe, expect, it } from 'vitest'

import { AI_EMBEDDING_MODEL_KEYS, getAiEmbeddingModelSpec } from './embedding-model-registry'

describe('embedding model registry', () => {
  it.each([
    AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT,
    AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT,
    AI_EMBEDDING_MODEL_KEYS.ANALYTICS_CLUSTERING,
  ])('keeps worker retries at the BullMQ boundary for %s', (modelKey) => {
    expect(getAiEmbeddingModelSpec(modelKey)).toMatchObject({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1_536,
      timeoutMs: 10_000,
      maxAttempts: 1,
      inputUsdPerMillionTokens: 0.02,
    })
  })

  it('preserves the guest-query retry contract', () => {
    expect(getAiEmbeddingModelSpec(AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY).maxAttempts).toBe(2)
  })
})
