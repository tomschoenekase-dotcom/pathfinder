import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyProviderFailure } from './provider-diagnostics'
import { AiGatewayError, generateText } from './anthropic'
import { NOOP_AI_BUDGET_GATE } from './budget'
import { setOpenAiResponsesClientForTesting } from './openai-text'
import { generateEmbedding, setOpenAiEmbeddingsClientForTesting } from './openai-embeddings'

afterEach(() => {
  setOpenAiResponsesClientForTesting(null)
  setOpenAiEmbeddingsClientForTesting(null)
})

describe('safe provider diagnostics', () => {
  it('finds provider quota inside a TRPC-style import failure cause', () => {
    const provider = new AiGatewayError('AI provider request failed', {
      attempts: 1,
      code: 'provider-http-429',
      cause: { status: 429, error: { code: 'credit_balance_exhausted' } },
    })
    const trpc = Object.assign(new Error('Import unavailable', { cause: provider }), {
      name: 'TRPCError',
      code: 'SERVICE_UNAVAILABLE',
    })
    expect(classifyProviderFailure(trpc)).toMatchObject({
      code: 'PROVIDER_CREDITS_EXHAUSTED',
      httpStatus: 429,
      providerCode: 'credit_balance_exhausted',
    })
  })
  it.each([
    { type: 'error', status: 429, code: 'insufficient_quota' },
    {
      type: 'response.failed',
      response: { status: 'failed', error: { code: 'credit_balance_exhausted', status: 429 } },
    },
  ])('retains structured stream failure metadata without retrying: $type', async (event) => {
    const create = vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield event
      },
    })
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const usageSink = vi.fn().mockResolvedValue(undefined)
    await expect(
      generateText({
        modelKey: 'guest-chat-luna',
        system: [{ type: 'text', text: 'Fictional guide' }],
        messages: [{ role: 'user', content: 'Fictional question' }],
        usageSink,
        admissionGuard: async () => undefined,
        budgetGate: NOOP_AI_BUDGET_GATE,
        maxAttempts: 3,
        retryDelayMs: 0,
        onTextDelta: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_CREDITS_EXHAUSTED',
      diagnostics: { httpStatus: 429, code: 'PROVIDER_CREDITS_EXHAUSTED' },
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'PROVIDER_CREDITS_EXHAUSTED', providerHttpStatus: 429 }),
    )
  })
  it.each(['insufficient_quota', 'credit_balance_exhausted'])(
    'preserves %s through wrapped SDK causes without copying content',
    (code) => {
      const raw = {
        status: 429,
        error: { code, message: 'fictional private request' },
        headers: { authorization: 'fictional credential' },
      }
      const wrapped = new AiGatewayError('Provider failed', {
        attempts: 1,
        code: 'provider-http-429',
        cause: new Error('private', { cause: raw }),
      })
      expect(wrapped.code).toBe('PROVIDER_CREDITS_EXHAUSTED')
      expect(wrapped.diagnostics).toEqual({
        code: 'PROVIDER_CREDITS_EXHAUSTED',
        httpStatus: 429,
        providerCode: code,
        retryable: false,
      })
      expect(JSON.stringify(wrapped.diagnostics)).not.toMatch(/private|credential|authorization/u)
    },
  )
  it.each([
    [{ status: 429 }, 'PROVIDER_RATE_LIMITED', true],
    [{ status: 503 }, 'PROVIDER_UNAVAILABLE', true],
    [{ status: 401 }, 'PROVIDER_AUTHENTICATION_FAILED', false],
    [{ code: 'provider-not-configured' }, 'PROVIDER_NOT_CONFIGURED', false],
    [{ name: 'APIConnectionTimeoutError' }, 'PROVIDER_TIMEOUT', true],
    [{ name: 'APIConnectionError' }, 'PROVIDER_CONNECTION_FAILED', true],
  ])('classifies bounded metadata %j', (error, code, retryable) => {
    expect(classifyProviderFailure(error)).toMatchObject({ code, retryable })
  })
  it('does not infer billing from message text or reflect arbitrary metadata', () => {
    expect(
      classifyProviderFailure({
        message: 'insufficient_quota',
        code: 'fictional-private-code',
        status: 999,
      }),
    ).toEqual({ code: 'PROVIDER_UNKNOWN', providerCode: null, httpStatus: null, retryable: false })
  })
  it('bounds cycles, cause depth and throwing accessors', () => {
    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(classifyProviderFailure(cyclic).code).toBe('PROVIDER_UNKNOWN')
    const getter = vi.fn(() => {
      throw new Error('private')
    })
    expect(classifyProviderFailure(Object.defineProperty({}, 'code', { get: getter })).code).toBe(
      'PROVIDER_UNKNOWN',
    )
    expect(getter).not.toHaveBeenCalled()
    let nested: unknown = { code: 'insufficient_quota' }
    for (let i = 0; i < 8; i += 1) nested = { cause: nested }
    expect(classifyProviderFailure(nested).code).toBe('PROVIDER_UNKNOWN')
  })
  it('never retries quota failures and records safe usage metadata in text and embeddings', async () => {
    const quota = {
      status: 429,
      error: { code: 'insufficient_quota', message: 'fictional private message' },
    }
    const createText = vi.fn().mockRejectedValue(quota)
    const createEmbedding = vi.fn().mockRejectedValue(quota)
    setOpenAiResponsesClientForTesting({ responses: { create: createText } })
    setOpenAiEmbeddingsClientForTesting({ embeddings: { create: createEmbedding } })
    const usageSink = vi.fn().mockResolvedValue(undefined)
    const common = {
      usageSink,
      admissionGuard: async () => undefined,
      budgetGate: NOOP_AI_BUDGET_GATE,
      maxAttempts: 3,
      retryDelayMs: 0,
    }
    await expect(
      generateText({
        ...common,
        modelKey: 'guest-chat-luna',
        system: [{ type: 'text', text: 'Fictional guide' }],
        messages: [{ role: 'user', content: 'Fictional question' }],
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CREDITS_EXHAUSTED', attempts: 1 })
    await expect(
      generateEmbedding({
        ...common,
        modelKey: 'guest-query-embedding',
        text: 'Fictional question',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CREDITS_EXHAUSTED', attempts: 1 })
    expect(createText).toHaveBeenCalledTimes(1)
    expect(createEmbedding).toHaveBeenCalledTimes(1)
    expect(usageSink).toHaveBeenCalledTimes(2)
    for (const [record] of usageSink.mock.calls)
      expect(record).toMatchObject({
        errorCode: 'PROVIDER_CREDITS_EXHAUSTED',
        providerHttpStatus: 429,
        providerErrorCode: 'insufficient_quota',
        providerFailureCode: 'PROVIDER_CREDITS_EXHAUSTED',
      })
  })
})
