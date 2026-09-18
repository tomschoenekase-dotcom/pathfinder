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

  it('pins direct DeepSeek visitor-chat canaries to conservative peak rates', () => {
    expect(getAiModelSpec(AI_MODEL_KEYS.GUEST_CHAT_DEEPSEEK_FLASH)).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-flash',
      costTier: 'ECONOMY',
      pricingVersion: 'deepseek-2026-09-18-peak',
      pricingUsdPerMillionTokens: { input: 0.3, output: 1.2, cacheWrite: 0, cacheRead: 0.006 },
    })
    expect(getAiModelSpec(AI_MODEL_KEYS.GUEST_CHAT_DEEPSEEK_PRO)).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      costTier: 'PREMIUM',
      pricingVersion: 'deepseek-2026-09-18-peak',
      pricingUsdPerMillionTokens: { input: 1.32, output: 3.96, cacheWrite: 0, cacheRead: 0.044 },
    })
  })
})
