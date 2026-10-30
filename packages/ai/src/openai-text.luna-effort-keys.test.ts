import { afterEach, describe, expect, it, vi } from 'vitest'

import { getAiModelSpec, type AiModelKey } from './model-registry'
import { createOpenAiTextResponse, setOpenAiResponsesClientForTesting } from './openai-text'

const usage = { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }
const call = async (key: AiModelKey) => {
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

const cases = [
  { key: 'guest-chat-luna-reasoning-high', effort: 'high', tier: undefined },
  { key: 'guest-chat-luna-reasoning-medium-fast', effort: 'medium', tier: 'fast' },
  { key: 'guest-chat-luna-reasoning-high-fast', effort: 'high', tier: 'fast' },
] as const

describe('Luna effort and Fast model keys', () => {
  afterEach(() => setOpenAiResponsesClientForTesting(null))

  for (const { key, effort, tier } of cases) {
    it(`${key} sends effort ${effort}${tier ? ' on Fast' : ' at the default tier'}`, async () => {
      const { request, options } = await call(key)
      const reasoning = await call('guest-chat-luna-reasoning')
      expect(request.model).toBe('gpt-6-luna')
      expect(request.reasoning).toEqual({ effort })
      expect(request.max_output_tokens).toBe(2048)
      expect(request.store).toBe(false)
      expect(options.timeout).toBe(20_000)
      if (tier) expect(request.service_tier).toBe(tier)
      else expect(request).not.toHaveProperty('service_tier')
      // Apart from effort and tier, the request is the brief-reasoning route's request.
      const strip = ({ reasoning: _r, service_tier: _t, ...rest }: Record<string, unknown>) => rest
      expect(strip(request)).toEqual(strip(reasoning.request))
    })
  }

  it('prices standard tier at Luna rates and Fast at twice those rates', () => {
    const luna = getAiModelSpec('guest-chat-luna')
    const high = getAiModelSpec('guest-chat-luna-reasoning-high')
    expect(high.pricingUsdPerMillionTokens).toEqual(luna.pricingUsdPerMillionTokens)
    expect(high.pricingVersion).toBe(luna.pricingVersion)
    expect(high.costTier).toBe('ECONOMY')
    for (const key of [
      'guest-chat-luna-reasoning-medium-fast',
      'guest-chat-luna-reasoning-high-fast',
    ] as const) {
      const spec = getAiModelSpec(key)
      expect(spec.pricingUsdPerMillionTokens).toEqual({
        input: luna.pricingUsdPerMillionTokens.input * 2,
        output: luna.pricingUsdPerMillionTokens.output * 2,
        cacheWrite: luna.pricingUsdPerMillionTokens.cacheWrite * 2,
        cacheRead: luna.pricingUsdPerMillionTokens.cacheRead * 2,
      })
      expect(spec.pricingVersion).toBe(getAiModelSpec('guest-chat-sol-fast').pricingVersion)
    }
  })

  it('leaves the existing Luna routes unchanged', () => {
    expect(getAiModelSpec('guest-chat-luna-reasoning').reasoningEffort).toBe('low')
    expect(getAiModelSpec('guest-chat-luna-reasoning').serviceTier).toBeUndefined()
    expect(getAiModelSpec('guest-chat-luna').reasoningEffort).toBeUndefined()
  })
})
