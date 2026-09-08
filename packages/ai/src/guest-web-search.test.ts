import { describe, expect, it, vi } from 'vitest'

import { GuestWebSearchError, searchGuestWeb } from './guest-web-search'

const openAiMock = vi.hoisted(() => ({ constructor: vi.fn(), create: vi.fn() }))
vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: openAiMock.create }
    constructor(options: unknown) {
      openAiMock.constructor(options)
    }
  },
}))

const completeResponse = {
  id: 'resp_1',
  model: 'caller-model',
  status: 'completed',
  usage: {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 9,
    total_tokens: 21,
  },
  output: [
    {
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'search',
        sources: [
          { type: 'url', title: 'Source one', url: 'https://facts.example.org/one#part' },
          { type: 'url', title: 'Private', url: 'http://127.0.0.1/private' },
        ],
      },
    },
    {
      type: 'message',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'A bounded general answer.',
          annotations: [
            {
              type: 'url_citation',
              title: 'Source one cited',
              url: 'https://facts.example.org/one#citation',
              start_index: 0,
              end_index: 7,
            },
          ],
        },
      ],
    },
  ],
}

function setup(response: unknown = completeResponse) {
  const create = vi.fn().mockResolvedValue(response)
  return {
    create,
    params: {
      query: '  Why   do stars shine?  ',
      allowedDomains: ['example.org'],
      model: 'caller-model',
      timeoutMs: 500,
      maxOutputTokens: 120,
      maxToolCalls: 1,
      maxResults: 3,
      client: { responses: { create } },
    },
  }
}

describe('guest web search adapter', () => {
  it('dispatches a stored-off domain-bounded request and retains citations, sources, and usage', async () => {
    const { create, params } = setup()
    const result = await searchGuestWeb(params)

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'caller-model',
        input: 'Why do stars shine?',
        tools: [{ type: 'web_search', filters: { allowed_domains: ['example.org'] } }],
        tool_choice: { type: 'web_search' },
        include: ['web_search_call.action.sources'],
        max_output_tokens: 120,
        max_tool_calls: 1,
        parallel_tool_calls: false,
        store: false,
      }),
      expect.objectContaining({ timeout: 500, signal: expect.any(AbortSignal) }),
    )
    expect(result).toEqual({
      provider: 'openai',
      model: 'caller-model',
      responseId: 'resp_1',
      text: 'A bounded general answer.',
      references: [
        { title: 'Source one cited', url: 'https://facts.example.org/one', cited: true },
      ],
      usage: {
        inputTokens: 12,
        cachedInputTokens: 2,
        outputTokens: 9,
        totalTokens: 21,
        webSearchToolCalls: 1,
      },
    })
  })

  it('configures the default SDK client with the existing API key convention and no retries', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture-key')
    openAiMock.create.mockResolvedValueOnce(completeResponse)
    const { params } = setup()
    const { client, ...withoutClient } = params
    expect(client).toBeDefined()
    await searchGuestWeb(withoutClient)
    expect(openAiMock.constructor).toHaveBeenCalledWith({
      apiKey: 'fixture-key',
      maxRetries: 0,
    })
    vi.unstubAllEnvs()
  })

  it.each([
    { allowedDomains: [] },
    { allowedDomains: ['localhost'] },
    { allowedDomains: ['https://example.org/path'] },
    { allowedDomains: ['127.0.0.1'] },
    { allowedDomains: ['service.internal'] },
    { allowedDomains: ['user@example.org'] },
  ])(
    'does not dispatch without a valid server domain allowlist: %j',
    async ({ allowedDomains }) => {
      const { create, params } = setup()
      await expect(searchGuestWeb({ ...params, allowedDomains })).rejects.toMatchObject({
        code: 'invalid-request',
      })
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('rejects an overlong normalized query instead of silently truncating it', async () => {
    const { create, params } = setup()
    await expect(searchGuestWeb({ ...params, query: 'x'.repeat(501) })).rejects.toMatchObject({
      code: 'invalid-request',
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('bounds retained results and excludes malformed, non-HTTPS, private, and unapproved URLs', async () => {
    const { params } = setup({
      ...completeResponse,
      output: [
        {
          type: 'web_search_call',
          status: 'completed',
          action: {
            sources: [
              { url: 'https://one.example.org/a', title: 'One' },
              { url: 'https://two.example.org/b', title: 'Two' },
              { url: 'notaurl', title: 'Bad' },
              { url: 'http://one.example.org/insecure', title: 'Insecure' },
              { url: 'https://127.0.0.1/private', title: 'Private' },
              { url: 'https://example.net/outside', title: 'Outside' },
            ],
          },
        },
        completeResponse.output[1],
      ],
    })
    const result = await searchGuestWeb({ ...params, maxResults: 2 })
    expect(result.references).toHaveLength(2)
    expect(result.references.map(({ url }) => url)).toEqual([
      'https://facts.example.org/one',
      'https://one.example.org/a',
    ])
  })

  it('rejects an unsafe cited URL so answer text cannot outlive mandatory attribution', async () => {
    const { params } = setup({
      ...completeResponse,
      output: [
        completeResponse.output[0],
        {
          ...completeResponse.output[1],
          content: [
            {
              type: 'output_text',
              text: 'Unsafe citation.',
              annotations: [
                {
                  type: 'url_citation',
                  title: 'Unsafe',
                  url: 'https://facts.example.org/page?access_token=secret',
                },
              ],
            },
          ],
        },
      ],
    })
    await expect(searchGuestWeb(params)).rejects.toMatchObject({
      code: 'invalid-provider-response',
      observedUsage: {
        model: 'caller-model',
        usage: {
          inputTokens: 12,
          cachedInputTokens: 2,
          outputTokens: 9,
          totalTokens: 21,
          webSearchToolCalls: 1,
        },
      },
    })
  })

  it('does not expose observed usage when usage or tool-call count is unknown', async () => {
    const missingUsage = setup({ ...completeResponse, usage: undefined })
    const unknownTool = setup({
      ...completeResponse,
      output: [...completeResponse.output, { type: 'future_tool_call' }],
    })

    for (const params of [missingUsage.params, unknownTool.params]) {
      try {
        await searchGuestWeb(params)
        throw new Error('Expected search to reject')
      } catch (error) {
        expect(error).toMatchObject({ code: 'invalid-provider-response' })
        expect((error as GuestWebSearchError).observedUsage).toBeUndefined()
      }
    }
  })

  it.each([
    [{ ...completeResponse, status: 'incomplete' }, 'incomplete-provider-response'],
    [{ ...completeResponse, usage: undefined }, 'invalid-provider-response'],
    [{ ...completeResponse, output: [{ type: 'future_item' }] }, 'invalid-provider-response'],
    [
      {
        ...completeResponse,
        output: [{ type: 'web_search_call', status: 'failed' }, completeResponse.output[1]],
      },
      'incomplete-provider-response',
    ],
  ])('fails closed for incomplete or unknown response shape', async (response, code) => {
    const { params } = setup(response)
    await expect(searchGuestWeb(params)).rejects.toMatchObject({ code })
  })

  it('honors caller cancellation', async () => {
    const controller = new AbortController()
    const create = vi.fn((_body: unknown, options: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        })
      })
    })
    const { params } = setup()
    const pending = searchGuestWeb({
      ...params,
      client: { responses: { create } },
      signal: controller.signal,
    })
    controller.abort(new Error('cancel'))
    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<GuestWebSearchError>>({ code: 'cancelled' }),
    )
  })

  it('aborts a provider request at the caller-supplied timeout', async () => {
    const create = vi.fn((_body: unknown, options: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        })
      })
    })
    const { params } = setup()
    await expect(
      searchGuestWeb({ ...params, timeoutMs: 5, client: { responses: { create } } }),
    ).rejects.toMatchObject({ code: 'provider-error' })
    expect(create).toHaveBeenCalledOnce()
  })
})
