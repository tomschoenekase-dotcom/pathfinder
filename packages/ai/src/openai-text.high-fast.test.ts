import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAiModelSpec } from './model-registry'
import {
  createOpenAiTextResponse,
  createOpenAiTextStream,
  setOpenAiResponsesClientForTesting,
} from './openai-text'
const usage = { input_tokens: 10, output_tokens: 5 }
describe('production high-fast route', () => {
  afterEach(() => setOpenAiResponsesClientForTesting(null))
  it.each([false, true])('pins exact provider settings (stream=%s)', async (stream) => {
    const create = vi.fn().mockImplementation(async () =>
      stream
        ? (async function* () {
            yield {
              type: 'response.completed',
              response: { status: 'completed', output_text: 'Done', usage },
            }
          })()
        : { status: 'completed', output_text: 'Done', usage },
    )
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const spec = getAiModelSpec('guest-chat-luna-reasoning-high-fast')
    const params = {
      spec,
      system: [{ type: 'text' as const, text: 'Rules' }],
      messages: [{ role: 'user' as const, content: 'Hello' }],
      maxOutputTokens: spec.maxOutputTokens,
      timeoutMs: spec.timeoutMs,
    }
    if (stream) await createOpenAiTextStream({ ...params, onTextDelta: () => {} })
    else await createOpenAiTextResponse(params)
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-6-luna',
      reasoning: { effort: 'high' },
      service_tier: 'fast',
      max_output_tokens: 4096,
      store: false,
    })
    expect(create.mock.calls[0]?.[1]).toEqual({ timeout: 25_000 })
    expect(spec.maxAttempts).toBe(2)
    expect(spec.pricingUsdPerMillionTokens).toEqual({
      input: 0.2,
      output: 1,
      cacheWrite: 0.25,
      cacheRead: 0.02,
    })
  })
  it('preserves the existing Luna provider request', async () => {
    const create = vi.fn().mockResolvedValue({ status: 'completed', output_text: 'Done', usage })
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const spec = getAiModelSpec('guest-chat-luna')
    await createOpenAiTextResponse({
      spec,
      system: [],
      messages: [{ role: 'user', content: 'Hi' }],
      maxOutputTokens: spec.maxOutputTokens,
      timeoutMs: spec.timeoutMs,
    })
    expect(create.mock.calls[0]?.[0]).toEqual({
      instructions: '',
      prompt_cache_options: { mode: 'explicit' },
      model: 'gpt-6-luna',
      input: [{ role: 'user', content: 'Hi' }],
      max_output_tokens: 1024,
      reasoning: { effort: 'none' },
      store: false,
    })
    expect(create.mock.calls[0]?.[1]).toEqual({ timeout: 15_000 })
  })
})
