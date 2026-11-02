import { afterEach, describe, expect, it, vi } from 'vitest'

import { getAiModelSpec } from './model-registry'
import { createOpenAiTextResponse, createOpenAiTextStream, setOpenAiResponsesClientForTesting } from './openai-text'

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

  it.each(['guest-chat-luna', 'guest-chat-luna-reasoning'] as const)(
    'sends high Fast through %s with the runtime cap, timeout and rates',
    async (key) => {
      const { request, options } = await call(key)
      expect(request.model).toBe('gpt-6-luna')
      expect(request.reasoning).toEqual({ effort: 'high' })
      expect(request.service_tier).toBe('fast')
      expect(request.max_output_tokens).toBe(8192)
      expect(options.timeout).toBe(60_000)
      expect(getAiModelSpec(key).pricingUsdPerMillionTokens).toEqual({
        input: 0.2,
        output: 1,
        cacheWrite: 0.25,
        cacheRead: 0.02,
      })
    },
  )
  it.each(['guest-chat-luna', 'guest-chat-luna-reasoning'] as const)('streams %s using the same high Fast runtime boundary', async key => {
    const create = vi.fn().mockResolvedValue((async function* () {
      yield { type: 'response.completed', response: { status: 'completed', output_text: 'Done', usage } }
    })())
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const spec = getAiModelSpec(key)
    await createOpenAiTextStream({ spec, system: [], messages: [{role: 'user', content: 'Hello'}], maxOutputTokens: spec.maxOutputTokens, timeoutMs: spec.timeoutMs, onTextDelta: () => {} })
    expect(create.mock.calls[0]?.[0]).toMatchObject({ reasoning: {effort: 'high'}, service_tier: 'fast', max_output_tokens: 8192, stream: true })
    expect(create.mock.calls[0]?.[1]).toEqual({timeout: 60_000})
  })

})
