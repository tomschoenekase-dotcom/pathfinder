import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APIConnectionError, APIConnectionTimeoutError } from 'openai'

import { AI_EMBEDDING_MODEL_KEYS } from './embedding-model-registry'
import { NOOP_AI_BUDGET_GATE, type AiBudgetGate } from './budget'
import {
  generateEmbedding,
  generateEmbeddings,
  setOpenAiEmbeddingsClientForTesting,
  type OpenAiEmbeddingsClient,
} from './openai-embeddings'

const create = vi.fn()
const client = { embeddings: { create } } as OpenAiEmbeddingsClient
const usageSink = vi.fn()
const admissionGuard = vi.fn().mockResolvedValue(undefined)

function budgetGate(overrides: Partial<AiBudgetGate> = {}): AiBudgetGate {
  return {
    reserve: vi.fn().mockResolvedValue({ id: 'reservation', reservedUnits: 600_000n }),
    markDispatched: vi.fn().mockResolvedValue(undefined),
    settleExact: vi.fn().mockResolvedValue(undefined),
    settleAmbiguous: vi.fn().mockResolvedValue(undefined),
    releaseUndispatched: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function vector(value: number): number[] {
  return Array.from({ length: 1_536 }, () => value)
}

describe('OpenAI embeddings gateway', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setOpenAiEmbeddingsClientForTesting(client)
    usageSink.mockResolvedValue(undefined)
  })

  it('uses the registered request contract, reorders vectors, and records cost', async () => {
    create.mockResolvedValueOnce({
      data: [
        { index: 1, embedding: vector(2) },
        { index: 0, embedding: vector(1) },
      ],
      usage: { prompt_tokens: 250, total_tokens: 250 },
    })

    const result = await generateEmbeddings({
      modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
      texts: ['first', 'second'],
      usageSink,
      admissionGuard,
      budgetGate: NOOP_AI_BUDGET_GATE,
    })

    expect(create).toHaveBeenCalledWith(
      {
        model: 'text-embedding-3-small',
        input: ['first', 'second'],
        dimensions: 1_536,
      },
      { timeout: 10_000 },
    )
    expect(result.embeddings[0]?.[0]).toBe(1)
    expect(result.embeddings[1]?.[0]).toBe(2)
    expect(result.estimatedCostUsd).toBe(0.000005)
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        model: 'text-embedding-3-small',
        usage: expect.objectContaining({ inputTokens: 250, outputTokens: 0 }),
        attempts: 1,
        success: true,
      }),
    )
  })

  it('returns the single-vector convenience result', async () => {
    create.mockResolvedValueOnce({
      data: [{ index: 0, embedding: vector(3) }],
      usage: { prompt_tokens: 4, total_tokens: 4 },
    })

    const result = await generateEmbedding({
      modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
      text: 'hello',
      usageSink,
      admissionGuard,
      budgetGate: NOOP_AI_BUDGET_GATE,
    })

    expect(result.embedding).toHaveLength(1_536)
    expect(result.embedding[0]).toBe(3)
  })

  it('retries one 503 and records the logical call once', async () => {
    create
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
      .mockResolvedValueOnce({
        data: [{ index: 0, embedding: vector(1) }],
        usage: { prompt_tokens: 10, total_tokens: 10 },
      })

    const result = await generateEmbedding({
      modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
      text: 'hello',
      usageSink,
      admissionGuard,
      budgetGate: NOOP_AI_BUDGET_GATE,
      retryDelayMs: 0,
    })

    expect(create).toHaveBeenCalledTimes(2)
    expect(result.attempts).toBe(2)
    expect(usageSink).toHaveBeenCalledTimes(1)
    expect(usageSink).toHaveBeenCalledWith(expect.objectContaining({ attempts: 2, success: true }))
  })

  it('retries the real SDK connection-timeout class', async () => {
    create.mockRejectedValueOnce(new APIConnectionTimeoutError()).mockResolvedValueOnce({
      data: [{ index: 0, embedding: vector(1) }],
      usage: { prompt_tokens: 10, total_tokens: 10 },
    })

    await expect(
      generateEmbedding({
        modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
        text: 'hello',
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
        retryDelayMs: 0,
      }),
    ).resolves.toMatchObject({ attempts: 2 })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('records the real SDK connection class with a stable terminal code', async () => {
    create.mockRejectedValue(new APIConnectionError({ message: 'offline' }))

    await expect(
      generateEmbedding({
        modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
        text: 'hello',
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
        retryDelayMs: 0,
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

  it('preserves observed billed usage when vector validation fails', async () => {
    create.mockResolvedValueOnce({
      data: [{ index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 12, total_tokens: 12 },
    })

    await expect(
      generateEmbedding({
        modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
        text: 'hello',
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).rejects.toMatchObject({ code: 'invalid-provider-response', attempts: 1 })

    expect(usageSink).toHaveBeenCalledTimes(1)
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'invalid-provider-response',
        usage: expect.objectContaining({ inputTokens: 12 }),
        estimatedCostUsd: 0.00000024,
      }),
    )
  })

  it('preserves observed billed usage when response data is missing', async () => {
    create.mockResolvedValueOnce({ usage: { prompt_tokens: 7, total_tokens: 7 } })

    await expect(
      generateEmbedding({
        modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
        text: 'hello',
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).rejects.toMatchObject({ code: 'invalid-provider-response', attempts: 1 })

    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'invalid-provider-response',
        usage: expect.objectContaining({ inputTokens: 7 }),
        estimatedCostUsd: 0.00000014,
      }),
    )
  })

  it('records a terminal provider failure with stable code and zero unknown usage', async () => {
    create.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }))

    await expect(
      generateEmbedding({
        modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
        text: 'hello',
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).rejects.toMatchObject({ code: 'provider-http-401', attempts: 1 })

    expect(create).toHaveBeenCalledTimes(1)
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'provider-http-401',
        usage: expect.objectContaining({ inputTokens: 0 }),
      }),
    )
  })

  it('does not change a valid result when usage persistence fails', async () => {
    create.mockResolvedValueOnce({
      data: [{ index: 0, embedding: vector(1) }],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    })
    usageSink.mockRejectedValueOnce(new Error('usage database unavailable'))

    await expect(
      generateEmbedding({
        modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
        text: 'hello',
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).resolves.toMatchObject({ embedding: expect.any(Array), attempts: 1 })
  })

  it('rejects blank input without a provider call', async () => {
    await expect(
      generateEmbedding({
        modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
        text: '   ',
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
      }),
    ).rejects.toThrow('Embedding input must contain nonblank text')
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    [{ maxAttempts: 0 }, 'maxAttempts must be a positive integer'],
    [{ maxAttempts: 1.5 }, 'maxAttempts must be a positive integer'],
    [{ timeoutMs: 0 }, 'timeoutMs must be a positive finite number'],
    [{ retryDelayMs: -1 }, 'retryDelayMs must be a nonnegative finite number'],
  ])('rejects invalid gateway overrides %#', async (overrides, message) => {
    await expect(
      generateEmbedding({
        modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
        text: 'hello',
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
        ...overrides,
      }),
    ).rejects.toThrow(message)
    expect(create).not.toHaveBeenCalled()
  })

  it('records a dispatched failure but not the retry denied by admission', async () => {
    admissionGuard
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('paused'))
    create.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))

    await expect(
      generateEmbedding({
        modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
        text: 'hello',
        usageSink,
        admissionGuard,
        budgetGate: NOOP_AI_BUDGET_GATE,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow('paused')

    expect(admissionGuard).toHaveBeenCalledTimes(3)
    expect(create).toHaveBeenCalledTimes(1)
    expect(usageSink).toHaveBeenCalledOnce()
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, errorCode: 'provider-http-503', success: false }),
    )
  })

  it('reserves between admissions, fences dispatch, and settles observed embedding cost', async () => {
    const order: string[] = []
    const settleExact = vi.fn().mockResolvedValue(undefined)
    const gate = budgetGate({
      reserve: vi.fn(async () => {
        order.push('reserve')
        return { id: 'reservation', reservedUnits: 600_000n }
      }),
      markDispatched: vi.fn(async () => {
        order.push('dispatch')
      }),
      settleExact,
    })
    admissionGuard.mockImplementation(async () => {
      order.push('admit')
    })
    create.mockImplementation(async () => {
      order.push('provider')
      return {
        data: [{ embedding: vector(0.2), index: 0, object: 'embedding' }],
        model: 'text-embedding-3-small',
        object: 'list',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }
    })

    await generateEmbedding({
      modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
      text: 'hello',
      usageSink,
      admissionGuard,
      budgetGate: gate,
    })

    expect(order).toEqual(['admit', 'reserve', 'admit', 'dispatch', 'provider'])
    expect(settleExact).toHaveBeenCalledWith({ id: 'reservation', reservedUnits: 600_000n }, 10n)
  })
})
