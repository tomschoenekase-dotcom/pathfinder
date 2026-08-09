import { describe, expect, it } from 'vitest'

import { AI_MODEL_KEYS, getAiModelSpec } from './model-registry'

describe('text model registry', () => {
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
