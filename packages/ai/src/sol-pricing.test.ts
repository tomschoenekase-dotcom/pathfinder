import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateText } from './anthropic'
import {
  NOOP_AI_BUDGET_GATE,
  textAttemptCostCeilingUnits,
  withAiRequestBudgetCeiling,
} from './budget'
import { AI_MODEL_KEYS, getAiModelSpec } from './model-registry'
import { setOpenAiResponsesClientForTesting } from './openai-text'

const system = [
  {
    type: 'text' as const,
    text: 'Stable guide context',
    cache_control: { type: 'ephemeral' as const },
  },
]
const messages = [{ role: 'user' as const, content: 'Hello' }]

describe('Sol standard 30-minute cache pricing', () => {
  afterEach(() => setOpenAiResponsesClientForTesting(null))

  it('reserves the premium write maximum and blocks a budget covering only ordinary input', async () => {
    const spec = getAiModelSpec(AI_MODEL_KEYS.GUEST_CHAT_SOL)
    const ceiling = textAttemptCostCeilingUnits({ spec, system, messages, maxOutputTokens: 32 })
    // 200,000 input at $2.50/million plus 32 output at $10/million.
    expect(ceiling).toBe(50_032_000n)
    const create = vi.fn()
    setOpenAiResponsesClientForTesting({ responses: { create } })
    await expect(
      generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT_SOL,
        system,
        messages,
        maxOutputTokens: 32,
        admissionGuard: vi.fn().mockResolvedValue(undefined),
        usageSink: vi.fn(),
        budgetGate: withAiRequestBudgetCeiling(NOOP_AI_BUDGET_GATE, 40_032_000n),
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_BUDGET_CEILING_EXCEEDED', attemptedUnits: ceiling })
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'reported write/read mix',
      detail: { cached_tokens: 500, cache_write_tokens: 400 },
      ordinary: 100,
      writes: 400,
      cost: 0.00135,
      units: 135_000n,
    },
    {
      name: 'missing-write conservative fallback',
      detail: { cached_tokens: 500 },
      ordinary: 0,
      writes: 500,
      cost: 0.0014,
      units: 140_000n,
    },
  ])(
    'records and settles $name using the actual gateway price calculation',
    async ({ detail, ordinary, writes, cost, units }) => {
      const create = vi.fn().mockResolvedValue({
        output_text: 'Welcome',
        usage: {
          input_tokens: 1000,
          output_tokens: 10,
          input_tokens_details: detail,
        },
      })
      setOpenAiResponsesClientForTesting({ responses: { create } })
      const reservation = { id: 'sol-reservation', reservedUnits: 50_032_000n }
      const gate = {
        reserve: vi.fn().mockResolvedValue(reservation),
        markDispatched: vi.fn().mockResolvedValue(undefined),
        settleExact: vi.fn().mockResolvedValue(undefined),
        settleAmbiguous: vi.fn(),
        releaseUndispatched: vi.fn(),
      }
      const usageSink = vi.fn().mockResolvedValue(undefined)
      const result = await generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT_SOL,
        system,
        messages,
        maxOutputTokens: 32,
        admissionGuard: vi.fn().mockResolvedValue(undefined),
        usageSink,
        budgetGate: gate,
      })
      expect(gate.reserve).toHaveBeenCalledWith(
        expect.objectContaining({
          reservedUnits: 50_032_000n,
          pricingVersion: 'openai-standard-public-2026-10-22',
        }),
      )
      expect(result.usage).toEqual({
        inputTokens: ordinary,
        cacheCreationInputTokens: writes,
        cacheReadInputTokens: 500,
        outputTokens: 10,
      })
      expect(result.estimatedCostUsd).toBeCloseTo(cost, 12)
      expect(gate.settleExact).toHaveBeenCalledWith(reservation, units)
      expect(usageSink).toHaveBeenCalledWith(
        expect.objectContaining({
          estimatedCostUsd: cost,
          pricingVersion: 'openai-standard-public-2026-10-22',
        }),
      )
      // No 12-hour mode is introduced: the existing explicit mode retains its documented 30m default.
      expect(create.mock.calls[0]?.[0].prompt_cache_options).toEqual({ mode: 'explicit' })
      expect(create.mock.calls[0]?.[0].input[0].content[0].prompt_cache_breakpoint).toEqual({
        mode: 'explicit',
      })
    },
  )
})
