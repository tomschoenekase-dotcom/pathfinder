import { describe, expect, it } from 'vitest'

import {
  AI_EMBEDDING_MODEL_KEYS,
  AI_EMBEDDING_MODEL_REGISTRY,
  getAiEmbeddingModelSpec,
} from './embedding-model-registry'
import { AI_MODEL_KEYS, AI_MODEL_REGISTRY, getAiModelSpec } from './model-registry'
import {
  embeddingAttemptCostCeilingUnits,
  observedAiCostUnits,
  textAttemptCostCeilingUnits,
} from './budget'

describe('AI cost budget ceilings', () => {
  it('uses the registered maximum billable text input and requested output ceiling', () => {
    const spec = getAiModelSpec(AI_MODEL_KEYS.GUEST_CHAT)
    expect(
      textAttemptCostCeilingUnits({
        spec,
        system: [],
        messages: [{ role: 'user', content: 'hello' }],
        maxOutputTokens: spec.maxOutputTokens,
      }),
    ).toBe(25_256_000n)
  })

  it('rejects text outside the verified input and output boundaries', () => {
    const spec = getAiModelSpec(AI_MODEL_KEYS.GUEST_CHAT)
    expect(() =>
      textAttemptCostCeilingUnits({
        spec,
        system: [],
        messages: [{ role: 'user', content: 'x'.repeat(spec.maxInputUtf8Bytes + 1) }],
        maxOutputTokens: spec.maxOutputTokens,
      }),
    ).toThrow('verified budget input boundary')
    expect(() =>
      textAttemptCostCeilingUnits({
        spec,
        system: [],
        messages: [{ role: 'user', content: 'hello' }],
        maxOutputTokens: spec.maxOutputTokens + 1,
      }),
    ).toThrow('registered output boundary')
  })

  it('uses the registered maximum embedding batch ceiling', () => {
    const spec = getAiEmbeddingModelSpec(AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY)
    expect(embeddingAttemptCostCeilingUnits({ spec, texts: ['hello'] })).toBe(600_000n)
  })

  it('rounds observed estimated cost upward to the budget scale', () => {
    expect(observedAiCostUnits(0.000000021)).toBe(3n)
    expect(observedAiCostUnits(0.000001)).toBe(100n)
  })

  it('produces positive exact ceilings for every registered gateway model', () => {
    for (const spec of Object.values(AI_MODEL_REGISTRY)) {
      const ceiling = textAttemptCostCeilingUnits({
        spec,
        system: [],
        messages: [{ role: 'user', content: 'registry audit' }],
        maxOutputTokens: spec.maxOutputTokens,
      })
      expect(ceiling).toBeGreaterThan(0n)
      expect(ceiling).toBeLessThan(BigInt(Number.MAX_SAFE_INTEGER))
    }
    for (const spec of Object.values(AI_EMBEDDING_MODEL_REGISTRY)) {
      const ceiling = embeddingAttemptCostCeilingUnits({ spec, texts: ['registry audit'] })
      expect(ceiling).toBeGreaterThan(0n)
      expect(ceiling).toBeLessThan(BigInt(Number.MAX_SAFE_INTEGER))
    }
  })
})
