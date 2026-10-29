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

  it('pins the Luna guest-chat candidate to GPT-6 Luna pricing', () => {
    expect(getAiModelSpec(AI_MODEL_KEYS.GUEST_CHAT_LUNA)).toMatchObject({
      provider: 'openai',
      model: 'gpt-6-luna',
      pricingVersion: 'openai-standard-public-2026-09-22',
      pricingUsdPerMillionTokens: {
        input: 0.1,
        output: 0.5,
        cacheWrite: 0.125,
        cacheRead: 0.01,
      },
    })
  })

  it('pins the Sol guest-chat route to GPT-6.1 Sol list pricing with room for reasoning', () => {
    expect(getAiModelSpec(AI_MODEL_KEYS.GUEST_CHAT_SOL)).toMatchObject({
      provider: 'openai',
      model: 'gpt-6.1-sol',
      maxOutputTokens: 2_048,
      pricingVersion: 'openai-standard-public-2026-10-22',
      pricingUsdPerMillionTokens: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
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

// Explicit pre-consolidation contract: exact SDK specs, including omitted properties, must survive
// moving their definitions to the pure registry. These are historical source constants, not prices
// fetched from a provider or recomputed from the new registry.
describe('guest execution spec consolidation parity', () => {
  const cases = [
    {
      key: 'guest-chat',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      tier: 'ECONOMY',
      output: 512,
      timeout: 10000,
      version: 'anthropic-public-2026-08-07',
      prices: [1, 5, 1.25, 0.1],
    },
    {
      key: 'guest-chat-openai',
      provider: 'openai',
      model: 'gpt-5-mini-2025-08-07',
      tier: 'ECONOMY',
      output: 512,
      timeout: 15000,
      version: 'openai-public-2026-08-26',
      prices: [0.25, 2, 0.25, 0.025],
    },
    {
      key: 'guest-chat-luna',
      provider: 'openai',
      model: 'gpt-6-luna',
      tier: 'ECONOMY',
      output: 1024,
      timeout: 15000,
      version: 'openai-standard-public-2026-09-22',
      prices: [0.1, 0.5, 0.125, 0.01],
    },
    {
      key: 'guest-chat-luna-reasoning',
      provider: 'openai',
      model: 'gpt-6-luna',
      tier: 'ECONOMY',
      output: 2048,
      timeout: 20000,
      version: 'openai-standard-public-2026-09-22',
      prices: [0.1, 0.5, 0.125, 0.01],
      reasoning: 'low',
    },
    {
      key: 'guest-chat-sol',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      tier: 'STANDARD',
      output: 2048,
      timeout: 20000,
      version: 'openai-standard-public-2026-10-22',
      prices: [2, 10, 2.5, 0.1],
    },
    {
      key: 'guest-chat-sol-fast',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      tier: 'STANDARD',
      output: 2048,
      timeout: 20000,
      version: 'openai-fast-public-2026-10-26',
      prices: [4, 20, 5, 0.2],
      fast: true,
    },
    {
      key: 'guest-chat-terra-fast',
      provider: 'openai',
      model: 'gpt-6.1-terra',
      tier: 'STANDARD',
      output: 2048,
      timeout: 20000,
      version: 'openai-fast-public-2026-10-26',
      prices: [2, 10, 2.5, 0.1],
      fast: true,
      reasoning: 'low',
    },
    {
      key: 'guest-chat-deepseek-flash',
      provider: 'deepseek',
      model: 'deepseek-flash',
      tier: 'ECONOMY',
      output: 512,
      timeout: 15000,
      version: 'deepseek-2026-09-18-peak',
      prices: [0.3, 1.2, 0, 0.006],
    },
    {
      key: 'guest-chat-deepseek-pro',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      tier: 'PREMIUM',
      output: 512,
      timeout: 15000,
      version: 'deepseek-2026-09-18-peak',
      prices: [1.32, 3.96, 0, 0.044],
    },
  ] as const
  it.each(cases)('preserves the exact $key spec', (expected) => {
    expect(getAiModelSpec(expected.key)).toEqual({
      provider: expected.provider,
      model: expected.model,
      costTier: expected.tier,
      maxOutputTokens: expected.output,
      timeoutMs: expected.timeout,
      maxAttempts: 2,
      maxInputUtf8Bytes: 180000,
      maxBillableInputTokens: 200000,
      pricingVersion: expected.version,
      pricingUsdPerMillionTokens: {
        input: expected.prices[0],
        output: expected.prices[1],
        cacheWrite: expected.prices[2],
        cacheRead: expected.prices[3],
      },
      ...('fast' in expected ? { serviceTier: 'fast' } : {}),
      ...('reasoning' in expected ? { reasoningEffort: expected.reasoning } : {}),
    })
  })
})
