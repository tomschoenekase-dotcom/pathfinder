import { describe, expect, it } from 'vitest'

import { AI_MODEL_KEYS, getAiModelSpec } from './model-registry'

describe('text model registry', () => {
  it('keeps Client Tochi on the bounded low-cost text workload', () => {
    expect(getAiModelSpec(AI_MODEL_KEYS.CLIENT_TOCHI)).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      maxOutputTokens: 384,
      timeoutMs: 8_000,
      maxAttempts: 2,
    })
  })

  it('preserves the tenant-wide weekly digest provider contract', () => {
    expect(getAiModelSpec(AI_MODEL_KEYS.WEEKLY_DIGEST)).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 1_200,
      timeoutMs: 30_000,
      maxAttempts: 1,
    })
  })
})
