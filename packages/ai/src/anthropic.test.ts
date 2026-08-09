import { APIConnectionError, APIConnectionTimeoutError } from '@anthropic-ai/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  generateText,
  setAnthropicClientForTesting,
  type AnthropicMessagesClient,
} from './anthropic'
import { AI_MODEL_KEYS } from './model-registry'

const create = vi.fn()
const usageSink = vi.fn()
const admissionGuard = vi.fn().mockResolvedValue(undefined)
const client = { messages: { create } } as AnthropicMessagesClient

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
    })

    expect(admissionGuard).toHaveBeenCalledTimes(2)
    expect(admissionGuard.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0]!,
    )
    expect(admissionGuard.mock.invocationCallOrder[1]).toBeLessThan(
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
      }),
    ).rejects.toThrow('paused')
    expect(create).not.toHaveBeenCalled()
    expect(usageSink).not.toHaveBeenCalled()
  })

  it('records a dispatched failure but not the retry denied by admission', async () => {
    admissionGuard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('paused'))
    create.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))

    await expect(
      generateText({
        modelKey: AI_MODEL_KEYS.GUEST_CHAT,
        system: [],
        messages: [{ role: 'user', content: 'Hello' }],
        retryDelayMs: 0,
        usageSink,
        admissionGuard,
      }),
    ).rejects.toThrow('paused')

    expect(create).toHaveBeenCalledOnce()
    expect(usageSink).toHaveBeenCalledOnce()
    expect(usageSink).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, errorCode: 'provider-http-503', success: false }),
    )
  })
})
