import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AiSystemBlock } from './anthropic'
import { getAiModelSpec } from './model-registry'
import {
  createOpenAiTextResponse,
  createOpenAiTextStream,
  setOpenAiResponsesClientForTesting,
} from './openai-text'

const stable: AiSystemBlock = {
  type: 'text',
  text: 'Shared application instructions',
  cache_control: { type: 'ephemeral' },
}

const usage = {
  input_tokens: 20,
  output_tokens: 3,
  input_tokens_details: { cached_tokens: 6, cache_write_tokens: 8 },
}

function request(
  model: string,
  system: AiSystemBlock[],
  provider: 'openai' | 'deepseek' = 'openai',
) {
  return {
    spec: { ...getAiModelSpec('guest-chat-luna'), provider, model },
    system,
    messages: [{ role: 'user' as const, content: 'Current question' }],
    maxOutputTokens: 32,
    timeoutMs: 1000,
  }
}

describe('OpenAI Responses prompt cache accounting', () => {
  afterEach(() => setOpenAiResponsesClientForTesting(null))

  it.each(['gpt-5.6', 'gpt-6-luna', 'gpt-6.1-sol'])(
    'places one explicit breakpoint after the stable system prefix on %s',
    async (model) => {
      const create = vi.fn().mockResolvedValue({ output_text: 'Done', usage })
      setOpenAiResponsesClientForTesting({ responses: { create } })
      const system = [stable, { type: 'text' as const, text: 'Volatile context A' }]
      const first = await createOpenAiTextResponse(request(model, system))
      system[1] = { type: 'text', text: 'Volatile context B' }
      await createOpenAiTextResponse(request(model, system))

      const firstPayload = create.mock.calls[0]?.[0]
      const secondPayload = create.mock.calls[1]?.[0]
      expect(firstPayload).not.toHaveProperty('instructions')
      expect(firstPayload.prompt_cache_options).toEqual({ mode: 'explicit' })
      expect(firstPayload.input).toEqual([
        {
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: stable.text,
              prompt_cache_breakpoint: { mode: 'explicit' },
            },
          ],
        },
        { role: 'developer', content: [{ type: 'input_text', text: 'Volatile context A' }] },
        { role: 'user', content: 'Current question' },
      ])
      expect(secondPayload.input[0]).toEqual(firstPayload.input[0])
      expect(secondPayload.input[1].content[0].text).toBe('Volatile context B')
      expect(first.usage).toEqual({
        inputTokens: 6,
        outputTokens: 3,
        cacheReadInputTokens: 6,
        cacheCreationInputTokens: 8,
      })
    },
  )

  it.each([
    ['gpt-6-luna', 'none'],
    ['gpt-6.1-sol', 'low'],
    ['gpt-5.6', 'minimal'],
  ])('asks %s for the reasoning effort it supports (%s)', async (model, effort) => {
    const create = vi.fn().mockResolvedValue({ output_text: 'Done', usage })
    setOpenAiResponsesClientForTesting({ responses: { create } })
    await createOpenAiTextResponse(request(model, [stable]))
    expect(create.mock.calls[0]?.[0].reasoning).toEqual({ effort })
  })

  it('turns off implicit caching when a supported model has no marked stable prefix', async () => {
    const create = vi.fn().mockResolvedValue({
      output_text: 'Done',
      usage: { input_tokens: 10, output_tokens: 1 },
    })
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const result = await createOpenAiTextResponse(
      request('gpt-6-luna', [{ type: 'text', text: 'Unmarked system content' }]),
    )
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      instructions: 'Unmarked system content',
      input: [{ role: 'user', content: 'Current question' }],
      prompt_cache_options: { mode: 'explicit' },
    })
    expect(result.usage.cacheCreationInputTokens).toBe(0)
  })

  it.each([
    ['gpt-5-mini-2025-08-07', 'openai'],
    ['deepseek-flash', 'deepseek'],
  ] as const)('keeps the legacy request shape for %s despite a marker', async (model, provider) => {
    const create = vi.fn().mockResolvedValue({ output_text: 'Done', usage })
    setOpenAiResponsesClientForTesting({ responses: { create } }, provider)
    await createOpenAiTextResponse(request(model, [stable], provider))
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      instructions: stable.text,
      input: [{ role: 'user', content: 'Current question' }],
    })
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('prompt_cache_options')
  })

  it('uses identical explicit cache controls and token partitions for streaming', async () => {
    const response = { status: 'completed', output_text: 'Done', usage }
    const create = vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'response.output_text.delta', delta: 'Done' }
        yield { type: 'response.completed', response }
      },
    })
    setOpenAiResponsesClientForTesting({ responses: { create } })
    const result = await createOpenAiTextStream({
      ...request('gpt-6.1-sol', [stable, { type: 'text', text: 'Dynamic' }]),
      onTextDelta: vi.fn(),
    })
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      stream: true,
      prompt_cache_options: { mode: 'explicit' },
      input: [
        { role: 'developer', content: [{ prompt_cache_breakpoint: { mode: 'explicit' } }] },
        { role: 'developer', content: [{ text: 'Dynamic' }] },
        { role: 'user', content: 'Current question' },
      ],
    })
    expect(result.usage).toEqual({
      inputTokens: 6,
      outputTokens: 3,
      cacheReadInputTokens: 6,
      cacheCreationInputTokens: 8,
    })
  })

  it.each([
    {
      input_tokens: 10,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: -1, cache_write_tokens: 0 },
    },
    {
      input_tokens: 10,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1.5 },
    },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 1 },
  ])('rejects malformed explicit-cache usage %#', async (invalidUsage) => {
    setOpenAiResponsesClientForTesting({
      responses: {
        create: vi.fn().mockResolvedValue({ output_text: 'Done', usage: invalidUsage }),
      },
    })
    await expect(createOpenAiTextResponse(request('gpt-6-luna', [stable]))).rejects.toThrow()
  })

  it.each([
    [
      'missing write detail',
      { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 4 } },
      { inputTokens: 0, cacheReadInputTokens: 4, cacheCreationInputTokens: 6 },
    ],
    [
      'missing details object',
      { input_tokens: 10, output_tokens: 1 },
      { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 10 },
    ],
    [
      'writes exceeding uncached input',
      {
        input_tokens: 10,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 },
      },
      { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 10 },
    ],
    [
      'reads exceeding input',
      {
        input_tokens: 10,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 11, cache_write_tokens: 0 },
      },
      { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 10 },
    ],
  ])(
    'keeps the answer and bills the upper bound for %s on explicit caching',
    async (_label, uncertainUsage, expected) => {
      setOpenAiResponsesClientForTesting({
        responses: {
          create: vi.fn().mockResolvedValue({ output_text: 'Done', usage: uncertainUsage }),
        },
      })
      const result = await createOpenAiTextResponse(request('gpt-6-luna', [stable]))
      expect(result.text).toBe('Done')
      expect(result.usage).toEqual({ ...expected, outputTokens: 1 })
    },
  )

  it('keeps a streamed answer when terminal cache-write detail is missing', async () => {
    const onTextDelta = vi.fn()
    setOpenAiResponsesClientForTesting({
      responses: {
        create: vi.fn().mockResolvedValue({
          async *[Symbol.asyncIterator]() {
            yield { type: 'response.output_text.delta', delta: 'Done' }
            yield {
              type: 'response.completed',
              response: {
                status: 'completed',
                output_text: 'Done',
                usage: {
                  input_tokens: 10,
                  output_tokens: 1,
                  input_tokens_details: { cached_tokens: 0 },
                },
              },
            }
          },
        }),
      },
    })
    const result = await createOpenAiTextStream({ ...request('gpt-6-luna', [stable]), onTextDelta })
    expect(onTextDelta).toHaveBeenCalledWith('Done')
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 10,
    })
  })

  it('rejects a stream that never reports usage', async () => {
    setOpenAiResponsesClientForTesting({
      responses: {
        create: vi.fn().mockResolvedValue({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'response.completed',
              response: { status: 'completed', output_text: 'Done', usage: null },
            }
          },
        }),
      },
    })
    await expect(
      createOpenAiTextStream({ ...request('gpt-6-luna', [stable]), onTextDelta: vi.fn() }),
    ).rejects.toThrow()
  })

  it('bills contradictory legacy cache detail as ordinary input', async () => {
    setOpenAiResponsesClientForTesting(
      {
        responses: {
          create: vi.fn().mockResolvedValue({
            output_text: 'Done',
            usage: {
              input_tokens: 10,
              output_tokens: 1,
              input_tokens_details: { cached_tokens: 12, cache_write_tokens: 5 },
            },
          }),
        },
      },
      'deepseek',
    )
    const result = await createOpenAiTextResponse(request('deepseek-flash', [stable], 'deepseek'))
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })
  })

  it('keeps missing cache-write detail compatible with the legacy path', async () => {
    setOpenAiResponsesClientForTesting({
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: 'Done',
          usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } },
        }),
      },
    })
    const result = await createOpenAiTextResponse(request('gpt-5-mini-2025-08-07', [stable]))
    expect(result.usage).toMatchObject({
      inputTokens: 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 2,
    })
  })
})
