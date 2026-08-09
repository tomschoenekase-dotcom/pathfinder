import { APIConnectionError, APIConnectionTimeoutError } from '@anthropic-ai/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  generateText,
  setAnthropicClientForTesting,
  type AnthropicMessagesClient,
} from './anthropic'
import { AI_MODEL_KEYS } from './model-registry'
import { NOOP_AI_BUDGET_GATE, type AiBudgetGate } from './budget'

const create = vi.fn()
const usageSink = vi.fn()
const admissionGuard = vi.fn().mockResolvedValue(undefined)
const client = { messages: { create } } as AnthropicMessagesClient

function budgetGate(overrides: Partial<AiBudgetGate> = {}): AiBudgetGate {
  return {
    reserve: vi.fn().mockResolvedValue({ id: 'reservation', reservedUnits: 1_000_000n }),
    markDispatched: vi.fn().mockResolvedValue(undefined),
    settleExact: vi.fn().mockResolvedValue(undefined),
    settleAmbiguous: vi.fn().mockResolvedValue(undefined),
    releaseUndispatched: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('generateText', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usageSink.mockResolvedValue(undefined)
    setAnthropicClientForTesting(client)
  })

  it('validates text, captures usage, and estimates cached-token cost', async () => {
    create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Welcome!' }],
      usage: {
        input_tokens: 1_000,
        output_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      },
    })

    const result = await generateText({
      modelKey: AI_MODEL_KEYS.GUEST_CHAT,
      system: [{ type: 'text', text: 'Guide.' }],
      messages: [{ role: 'user', content: 'Hello' }],
      usageSink,
      admissionGuard,
      budgetGate: NOOP_AI_BUDGET_GATE,
    })

    expect(result).toMatchObject({
      text: 'Welcome!',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      pricingVersion: 'anthropic-public-2026-08-07',
      attempts: 1,
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 300,
      },
    })
    expect(result.estimatedCostUsd).toBeCloseTo(0.00178, 8)
    expect(create).toHaveBeenCalledWith(expect.any(Object), { timeout: 10_000 })
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, usage: result.usage }),
    )
  })

  it('retries a transient provider failure once', async () => {
    create
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Recovered' }],
        usage: { input_tokens: 5, output_tokens: 2 },
      })

    const result = await generateText({
      modelKey: AI_MODEL_KEYS.GUEST_CHAT,
      system: [],
      messages: [{ role: 'user', content: 'Hello' }],
      retryDelayMs: 0,
      usageSink,
      admissionGuard,
      budgetGate: NOOP_AI_BUDGET_GATE,
    })

    expect(result.attempts).toBe(2)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed provider output without retrying', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Missing usage' }] })

    await expect(
      generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT,
        system: [],
        messages: [{ role: 'user', content: 'Hello' }],
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).rejects.toMatchObject({
      code: 'invalid-provider-response',
      attempts: 1,
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'invalid-provider-response',
        attempts: 1,
      }),
    )
  })

  it('rejects a blank provider text block', async () => {
    create.mockResolvedValueOnce({
      content: [{ type: 'text', text: '   ' }],
      usage: { input_tokens: 5, output_tokens: 1 },
    })

    await expect(
      generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT,
        system: [],
        messages: [{ role: 'user', content: 'Hello' }],
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).rejects.toMatchObject({ code: 'missing-text-block', attempts: 1 })
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'missing-text-block',
        usage: expect.objectContaining({ inputTokens: 5, outputTokens: 1 }),
      }),
    )
  })

  it('records structured parser rejection as a failed call', async () => {
    create.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"unexpected":true}' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    })

    await expect(
      generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT,
        system: [],
        messages: [{ role: 'user', content: 'Hello' }],
        parseResponse: () => {
          throw new Error('wrong shape')
        },
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).rejects.toMatchObject({ code: 'invalid-structured-output', attempts: 1 })
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'invalid-structured-output',
        usage: expect.objectContaining({ inputTokens: 5, outputTokens: 2 }),
      }),
    )
  })

  it('retries the actual SDK connection timeout error class', async () => {
    create.mockRejectedValueOnce(new APIConnectionTimeoutError()).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Recovered' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    })

    await expect(
      generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT,
        system: [],
        messages: [{ role: 'user', content: 'Hello' }],
        retryDelayMs: 0,
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).resolves.toMatchObject({ attempts: 2, text: 'Recovered' })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('records an exhausted SDK connection error with a stable code', async () => {
    create.mockRejectedValue(new APIConnectionError({ message: 'offline' }))

    await expect(
      generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT,
        system: [],
        messages: [{ role: 'user', content: 'Hello' }],
        retryDelayMs: 0,
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).rejects.toMatchObject({ code: 'provider-connection-error', attempts: 2 })
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'provider-connection-error',
        attempts: 2,
      }),
    )
  })

  it('does not let a failed usage sink change a successful provider result', async () => {
    usageSink.mockRejectedValueOnce(new Error('database unavailable'))
    create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Still succeeds' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    })

    await expect(
      generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT,
        system: [],
        messages: [{ role: 'user', content: 'Hello' }],
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).resolves.toMatchObject({ text: 'Still succeeds' })
  })

  it('checks admission before every provider attempt', async () => {
    create
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Recovered' }],
        usage: { input_tokens: 5, output_tokens: 2 },
      })

    await generateText({
      modelKey: AI_MODEL_KEYS.GUEST_CHAT,
      system: [],
      messages: [{ role: 'user', content: 'Hello' }],
      retryDelayMs: 0,
      usageSink,
      admissionGuard,
      budgetGate: NOOP_AI_BUDGET_GATE,
    })

    expect(admissionGuard).toHaveBeenCalledTimes(4)
    expect(admissionGuard.mock.invocationCallOrder[1]).toBeLessThan(
      create.mock.invocationCallOrder[0]!,
    )
    expect(admissionGuard.mock.invocationCallOrder[3]).toBeLessThan(
      create.mock.invocationCallOrder[1]!,
    )
  })

  it('does not call or account for a provider when admission is closed', async () => {
    admissionGuard.mockRejectedValueOnce(new Error('paused'))

    await expect(
      generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT,
        system: [],
        messages: [{ role: 'user', content: 'Hello' }],
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).rejects.toThrow('paused')
    expect(create).not.toHaveBeenCalled()
    expect(usageSink).not.toHaveBeenCalled()
  })

  it('records a dispatched failure but not the retry denied by admission', async () => {
    admissionGuard
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('paused'))
    create.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))

    await expect(
      generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT,
        system: [],
        messages: [{ role: 'user', content: 'Hello' }],
        retryDelayMs: 0,
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).rejects.toThrow('paused')

    expect(create).toHaveBeenCalledOnce()
    expect(usageSink).toHaveBeenCalledOnce()
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, errorCode: 'provider-http-503', success: false }),
    )
  })

  it('reserves between two admissions and fences dispatch before the provider', async () => {
    const order: string[] = []
    const gate = budgetGate({
      reserve: vi.fn(async () => {
        order.push('reserve')
        return { id: 'reservation', reservedUnits: 1_000_000n }
      }),
      markDispatched: vi.fn(async () => {
        order.push('mark-dispatched')
      }),
    })
    admissionGuard.mockImplementation(async () => {
      order.push('admit')
    })
    create.mockImplementationOnce(async () => {
      order.push('provider')
      return {
        content: [{ type: 'text', text: 'Ready' }],
        usage: { input_tokens: 2, output_tokens: 1 },
      }
    })

    await generateText({
      modelKey: AI_MODEL_KEYS.GUEST_CHAT,
      system: [],
      messages: [{ role: 'user', content: 'Hello' }],
      usageSink,
      admissionGuard,
      budgetGate: gate,
    })

    expect(order).toEqual(['admit', 'reserve', 'admit', 'mark-dispatched', 'provider'])
    expect(gate.settleExact).toHaveBeenCalledOnce()
    expect(gate.settleAmbiguous).not.toHaveBeenCalled()
  })

  it('releases a reservation when the second admission closes before dispatch', async () => {
    const gate = budgetGate()
    admissionGuard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('paused'))

    await expect(
      generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT,
        system: [],
        messages: [{ role: 'user', content: 'Hello' }],
        usageSink,
        admissionGuard,
        budgetGate: gate,
      }),
    ).rejects.toThrow('paused')

    expect(gate.releaseUndispatched).toHaveBeenCalledOnce()
    expect(gate.markDispatched).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('consumes an ambiguous attempt before reserving a provider retry', async () => {
    const reserve = vi
      .fn()
      .mockResolvedValueOnce({ id: 'attempt-1', reservedUnits: 1_000_000n })
      .mockResolvedValueOnce({ id: 'attempt-2', reservedUnits: 1_000_000n })
    const settleAmbiguous = vi.fn().mockResolvedValue(undefined)
    const gate = budgetGate({
      reserve,
      settleAmbiguous,
    })
    create
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Recovered' }],
        usage: { input_tokens: 2, output_tokens: 1 },
      })

    await generateText({
      modelKey: AI_MODEL_KEYS.GUEST_CHAT,
      system: [],
      messages: [{ role: 'user', content: 'Hello' }],
      retryDelayMs: 0,
      usageSink,
      admissionGuard,
      budgetGate: gate,
    })

    expect(gate.reserve).toHaveBeenCalledTimes(2)
    expect(gate.settleAmbiguous).toHaveBeenCalledWith({
      id: 'attempt-1',
      reservedUnits: 1_000_000n,
    })
    expect(gate.settleExact).toHaveBeenCalledWith(
      { id: 'attempt-2', reservedUnits: 1_000_000n },
      700n,
    )
    expect(settleAmbiguous.mock.invocationCallOrder[0]).toBeLessThan(
      reserve.mock.invocationCallOrder[1]!,
    )
  })
})
