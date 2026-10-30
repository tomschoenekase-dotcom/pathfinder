import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateText } from './anthropic'
import { NOOP_AI_BUDGET_GATE } from './budget'
import { setOpenAiResponsesClientForTesting } from './openai-text'

const exhausted = {
  status: 'incomplete',
  incomplete_details: { reason: 'max_output_tokens' },
  output: [],
  usage: {
    input_tokens: 100,
    output_tokens: 4096,
    output_tokens_details: { reasoning_tokens: 4096 },
  },
}
const answered = {
  status: 'completed',
  output_text: 'At 42 inches he can ride the carousel and the train.',
  output: [],
  usage: { input_tokens: 100, output_tokens: 600 },
}

function stream(response: Record<string, unknown>, text = '') {
  return (async function* () {
    if (text) yield { type: 'response.output_text.delta', delta: text }
    yield {
      type: response.status === 'completed' ? 'response.completed' : 'response.incomplete',
      response,
    }
  })()
}

function call(onTextDelta?: (delta: string) => void) {
  const usageSink = vi.fn().mockResolvedValue(undefined)
  return {
    usageSink,
    run: generateText({
      modelKey: 'guest-chat-luna-reasoning-high-fast',
      system: [{ type: 'text', text: 'Rules' }],
      messages: [{ role: 'user', content: 'Which rides can a 42-inch child ride?' }],
      usageSink,
      admissionGuard: vi.fn().mockResolvedValue(undefined),
      budgetGate: NOOP_AI_BUDGET_GATE,
      retryDelayMs: 0,
      ...(onTextDelta ? { onTextDelta } : {}),
    }),
  }
}

describe('high-effort reasoning that exhausts the output cap', () => {
  afterEach(() => setOpenAiResponsesClientForTesting(null))

  it.each([false, true])(
    'retries once at low effort when nothing was shown (stream=%s)',
    async (streaming) => {
      const create = vi
        .fn()
        .mockImplementationOnce(async () => (streaming ? stream(exhausted) : exhausted))
        .mockImplementationOnce(async () =>
          streaming ? stream(answered, answered.output_text) : answered,
        )
      setOpenAiResponsesClientForTesting({ responses: { create } })
      const deltas: string[] = []
      const { run, usageSink } = call(streaming ? (delta) => void deltas.push(delta) : undefined)
      const result = await run
      expect(result.text).toBe(answered.output_text)
      expect(result.attempts).toBe(2)
      expect(create).toHaveBeenCalledTimes(2)
      expect(create.mock.calls[0]?.[0]).toMatchObject({ reasoning: { effort: 'high' } })
      expect(create.mock.calls[1]?.[0]).toMatchObject({
        reasoning: { effort: 'low' },
        max_output_tokens: 4096,
        service_tier: 'fast',
      })
      // The exhausted attempt is billed and recorded; the guest only sees the answer.
      expect(usageSink.mock.calls[0]?.[0]).toMatchObject({
        success: false,
        errorCode: 'provider-reasoning-exhausted',
        usage: expect.objectContaining({ outputTokens: 4096 }),
      })
      expect(usageSink.mock.calls.at(-1)?.[0]).toMatchObject({ success: true, attempts: 2 })
      if (streaming) expect(deltas.join('')).toBe(answered.output_text)
    },
  )

  it('does not retry once text has streamed, so the guest never gets two answers', async () => {
    const create = vi.fn().mockImplementationOnce(async () => stream(exhausted, 'At 42 inches he'))
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const { run } = call(() => {})
    await expect(run).rejects.toMatchObject({ code: 'provider-incomplete-response' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('does not retry an incomplete response for another reason', async () => {
    const filtered = { ...exhausted, incomplete_details: { reason: 'content_filter' } }
    const create = vi.fn().mockResolvedValueOnce(filtered)
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const { run } = call()
    await expect(run).rejects.toMatchObject({ code: 'provider-incomplete-response' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('fails normally if the low-effort retry is also exhausted', async () => {
    const create = vi.fn().mockResolvedValue(exhausted)
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const { run } = call()
    await expect(run).rejects.toMatchObject({ code: 'provider-incomplete-response' })
    expect(create).toHaveBeenCalledTimes(2)
  })
})

describe('reasoning effort hint for long enumerations', () => {
  afterEach(() => setOpenAiResponsesClientForTesting(null))

  it('starts a high-effort route at medium and still falls back to low once', async () => {
    const create = vi.fn().mockResolvedValueOnce(exhausted).mockResolvedValueOnce(answered)
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const result = await generateText({
      modelKey: 'guest-chat-luna-reasoning-high-fast',
      system: [{ type: 'text', text: 'Rules' }],
      messages: [{ role: 'user', content: 'Which rides can my 42-inch son ride?' }],
      usageSink: vi.fn().mockResolvedValue(undefined),
      admissionGuard: vi.fn().mockResolvedValue(undefined),
      budgetGate: NOOP_AI_BUDGET_GATE,
      retryDelayMs: 0,
      reasoningEffortHint: 'medium',
    })
    expect(result.text).toBe(answered.output_text)
    expect(create.mock.calls[0]?.[0]).toMatchObject({ reasoning: { effort: 'medium' } })
    expect(create.mock.calls[1]?.[0]).toMatchObject({ reasoning: { effort: 'low' } })
  })

  it('ignores the hint on routes that are not high effort', async () => {
    const create = vi.fn().mockResolvedValueOnce(answered)
    setOpenAiResponsesClientForTesting({ responses: { create } })
    await generateText({
      modelKey: 'guest-chat-luna',
      system: [{ type: 'text', text: 'Rules' }],
      messages: [{ role: 'user', content: 'Which rides can my 42-inch son ride?' }],
      usageSink: vi.fn().mockResolvedValue(undefined),
      admissionGuard: vi.fn().mockResolvedValue(undefined),
      budgetGate: NOOP_AI_BUDGET_GATE,
      reasoningEffortHint: 'medium',
    })
    expect(create.mock.calls[0]?.[0].reasoning.effort).not.toBe('medium')
  })
})
