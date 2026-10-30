import { afterEach, describe, expect, it, vi } from 'vitest'

import { getAiModelSpec } from './model-registry'
import { createOpenAiTextResponse, setOpenAiResponsesClientForTesting } from './openai-text'

const usage = { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }
const call = async (key: 'guest-chat-luna' | 'guest-chat-luna-reasoning') => {
  const create = vi.fn().mockResolvedValue({ status: 'completed', output_text: 'Done', usage })
  setOpenAiResponsesClientForTesting({ responses: { create } })
  const spec = getAiModelSpec(key)
  await createOpenAiTextResponse({
    spec,
    system: [{ type: 'text', text: 'Rules.' }],
    messages: [{ role: 'user', content: 'Hello' }],
    maxOutputTokens: spec.maxOutputTokens,
    timeoutMs: spec.timeoutMs,
  })
  return { request: create.mock.calls[0]?.[0], options: create.mock.calls[0]?.[1] }
}

describe('Luna reasoning model key', () => {
  afterEach(() => setOpenAiResponsesClientForTesting(null))

  it('reasons at low effort with its own output cap and timeout, on the same model and prices', async () => {
    const { request, options } = await call('guest-chat-luna-reasoning')
    expect(request.model).toBe('gpt-6-luna')
    expect(request.reasoning).toEqual({ effort: 'low' })
    expect(request.max_output_tokens).toBe(2048)
    expect(options.timeout).toBe(20_000)
    const reasoning = getAiModelSpec('guest-chat-luna-reasoning')
    const plain = getAiModelSpec('guest-chat-luna')
    expect(reasoning.costTier).toBe('ECONOMY')
    expect(reasoning.pricingUsdPerMillionTokens).toEqual(plain.pricingUsdPerMillionTokens)
    expect(reasoning.pricingVersion).toBe(plain.pricingVersion)
  })

  it('leaves plain Luna unchanged', async () => {
    const { request, options } = await call('guest-chat-luna')
    expect(request.reasoning).toEqual({ effort: 'none' })
    expect(request.max_output_tokens).toBe(1024)
    expect(options.timeout).toBe(15_000)
  })
})
