import { describe, expect, it, vi } from 'vitest'

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
  withAiRequestBudgetCeiling,
  AiRequestBudgetCeilingExceededError,
  type AiBudgetGate,
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

  it('enforces one cumulative ceiling across exact, ambiguous, and released reservations', async () => {
    const underlying: AiBudgetGate = {
      reserve: vi.fn().mockResolvedValue(null),
      markDispatched: vi.fn().mockResolvedValue(undefined),
      settleExact: vi.fn().mockResolvedValue(undefined),
      settleAmbiguous: vi.fn().mockResolvedValue(undefined),
      releaseUndispatched: vi.fn().mockResolvedValue(undefined),
    }
    const gate = withAiRequestBudgetCeiling(underlying, 100n)
    const attempt = {
      invocationId: '11111111-1111-4111-8111-111111111111',
      attemptNumber: 1,
      provider: 'anthropic' as const,
      model: 'model',
      pricingVersion: 'test',
      reservedUnits: 60n,
    }

    const exact = await gate.reserve(attempt)
    expect(exact).not.toBeNull()
    await gate.settleExact(exact!, 20n)
    const released = await gate.reserve({ ...attempt, attemptNumber: 2, reservedUnits: 80n })
    await gate.releaseUndispatched(released!)
    const ambiguous = await gate.reserve({ ...attempt, attemptNumber: 3, reservedUnits: 80n })
    await gate.settleAmbiguous(ambiguous!)

    await expect(
      gate.reserve({ ...attempt, attemptNumber: 4, reservedUnits: 1n }),
    ).rejects.toMatchObject({
      code: 'REQUEST_BUDGET_CEILING_EXCEEDED',
      ceilingUnits: 100n,
      attemptedUnits: 101n,
    } satisfies Partial<AiRequestBudgetCeilingExceededError>)
  })
})
