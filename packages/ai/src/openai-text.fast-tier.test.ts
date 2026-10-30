import { afterEach, describe, expect, it, vi } from 'vitest'

import { getAiModelSpec } from './model-registry'
import {
  createOpenAiTextResponse,
  createOpenAiTextStream,
  setOpenAiResponsesClientForTesting,
} from './openai-text'

const usage = { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }
const system = [{ type: 'text' as const, text: 'Rules.' }]
const messages = [{ role: 'user' as const, content: 'Hello' }]

const callOnce = async (key: 'guest-chat-sol' | 'guest-chat-sol-fast') => {
  const create = vi.fn().mockResolvedValue({ status: 'completed', output_text: 'Done', usage })
  setOpenAiResponsesClientForTesting({ responses: { create } })
  const spec = getAiModelSpec(key)
  await createOpenAiTextResponse({
    spec,
    system,
    messages,
    maxOutputTokens: spec.maxOutputTokens,
    timeoutMs: spec.timeoutMs,
  })
  return create.mock.calls[0]?.[0]
}

const callStream = async (key: 'guest-chat-sol' | 'guest-chat-sol-fast') => {
  const create = vi.fn().mockResolvedValue(
    (async function* () {
      yield { type: 'response.output_text.delta', delta: 'Done' }
      yield {
        type: 'response.completed',
        response: { status: 'completed', output_text: 'Done', usage },
      }
    })(),
  )
  setOpenAiResponsesClientForTesting({ responses: { create } })
  const spec = getAiModelSpec(key)
  const result = await createOpenAiTextStream({
    spec,
    system,
    messages,
    maxOutputTokens: spec.maxOutputTokens,
    timeoutMs: spec.timeoutMs,
    onTextDelta: () => {},
  })
  return { request: create.mock.calls[0]?.[0], result }
}

describe('Sol Fast-mode model key', () => {
  afterEach(() => setOpenAiResponsesClientForTesting(null))

  it('requests the fast service tier on the same Sol model, effort, cap and timeout', async () => {
    const fast = getAiModelSpec('guest-chat-sol-fast')
    const plain = getAiModelSpec('guest-chat-sol')
    expect(fast).toMatchObject({
      model: plain.model,
      maxOutputTokens: plain.maxOutputTokens,
      timeoutMs: plain.timeoutMs,
      maxAttempts: plain.maxAttempts,
      serviceTier: 'fast',
    })
    const request = await callOnce('guest-chat-sol-fast')
    expect(request.model).toBe('gpt-6.1-sol')
    expect(request.reasoning).toEqual({ effort: 'low' })
    expect(request.service_tier).toBe('fast')
  })

  it('also requests the fast tier when streaming to a guest', async () => {
    const { request, result } = await callStream('guest-chat-sol-fast')
    expect(request.service_tier).toBe('fast')
    expect(request.stream).toBe(true)
    expect(result.text).toBe('Done')
  })

  it('uses the existing Fast registry prices including cache accounting', () => {
    expect(getAiModelSpec('guest-chat-sol-fast').pricingUsdPerMillionTokens).toEqual({
      input: 4,
      output: 20,
      cacheWrite: 5,
      cacheRead: 0.2,
    })
  })

  it('leaves standard Sol without a service tier in both paths', async () => {
    expect(getAiModelSpec('guest-chat-sol').serviceTier).toBeUndefined()
    expect(await callOnce('guest-chat-sol')).not.toHaveProperty('service_tier')
    expect((await callStream('guest-chat-sol')).request).not.toHaveProperty('service_tier')
  })
})
