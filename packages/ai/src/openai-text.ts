import OpenAI from 'openai'
import { z } from 'zod'

import type { AiMessage, AiSystemBlock, AiTokenUsage } from './anthropic'
import type { AiModelSpec, AiTextProviderId } from './model-registry'

const safeTokenCount = z.number().int().nonnegative().refine(Number.isSafeInteger)

const openAiResponseSchema = z.object({
  status: z.string().optional(),
  incomplete_details: z
    .object({ reason: z.string().optional() })
    .passthrough()
    .nullable()
    .optional(),
  output_text: z.string().optional(),
  output: z
    .array(
      z
        .object({
          type: z.string(),
          content: z
            .array(
              z
                .object({
                  type: z.string(),
                  text: z.string().optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    )
    .optional(),
  usage: z
    .object({
      input_tokens: safeTokenCount,
      output_tokens: safeTokenCount,
      input_tokens_details: z
        .object({
          cached_tokens: safeTokenCount.optional(),
          cache_write_tokens: safeTokenCount.optional(),
        })
        .passthrough()
        .optional(),
    })
    .nullable()
    .optional(),
})

export type OpenAiResponsesClient = {
  responses: {
    create: (
      params: {
        model: string
        instructions?: string
        input: Array<
          | AiMessage
          | {
              role: 'developer'
              content: Array<{
                type: 'input_text'
                text: string
                prompt_cache_breakpoint?: { mode: 'explicit' }
              }>
            }
        >
        prompt_cache_options?: { mode: 'explicit' }
        max_output_tokens: number
        reasoning: { effort: 'none' | 'minimal' }
        store: false
        stream?: boolean
      },
      options?: { timeout?: number; signal?: AbortSignal },
    ) => Promise<unknown>
  }
}

type OpenAiResponseStream = AsyncIterable<unknown>

const openAiStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('response.output_text.delta'), delta: z.string() }).passthrough(),
  z.object({ type: z.literal('response.completed'), response: openAiResponseSchema }).passthrough(),
  z
    .object({ type: z.literal('response.incomplete'), response: openAiResponseSchema })
    .passthrough(),
  z.object({ type: z.literal('response.failed'), response: openAiResponseSchema }).passthrough(),
])

type OpenAiResponsesProviderId = Extract<AiTextProviderId, 'openai' | 'deepseek'>

function reasoningEffort(model: string): 'none' | 'minimal' {
  return model === 'gpt-6-luna' ? 'none' : 'minimal'
}

function promptInput(
  provider: AiTextProviderId,
  model: string,
  system: AiSystemBlock[],
  messages: AiMessage[],
): Pick<
  Parameters<OpenAiResponsesClient['responses']['create']>[0],
  'instructions' | 'input' | 'prompt_cache_options'
> {
  const breakpointIndex = system.reduce(
    (last, block, index) => (block.cache_control?.type === 'ephemeral' ? index : last),
    -1,
  )
  const supportsExplicitCaching =
    provider === 'openai' && /^gpt-(?:5\.6|6|6\.1)(?:-|$)/u.test(model)
  if (!supportsExplicitCaching) {
    return { instructions: system.map((block) => block.text).join('\n\n'), input: messages }
  }
  if (breakpointIndex < 0) {
    return {
      instructions: system.map((block) => block.text).join('\n\n'),
      input: messages,
      prompt_cache_options: { mode: 'explicit' },
    }
  }
  return {
    input: [
      ...system.map((block, index) => ({
        role: 'developer' as const,
        content: [
          {
            type: 'input_text' as const,
            text: block.text,
            ...(index === breakpointIndex
              ? { prompt_cache_breakpoint: { mode: 'explicit' as const } }
              : {}),
          },
        ],
      })),
      ...messages,
    ],
    prompt_cache_options: { mode: 'explicit' },
  }
}

function hasExplicitBreakpoint(prompt: ReturnType<typeof promptInput>): boolean {
  return prompt.input.some(
    (message) =>
      message.role === 'developer' &&
      message.content.some((block) => block.prompt_cache_breakpoint?.mode === 'explicit'),
  )
}

function tokenUsage(
  usage: NonNullable<z.infer<typeof openAiResponseSchema>['usage']>,
  explicitCache: boolean,
): AiTokenUsage {
  const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0
  // Legacy request shapes keep the previous meaning: any reported write is
  // billed as ordinary input, because some providers price writes at zero.
  const cacheWriteTokens = explicitCache ? usage.input_tokens_details?.cache_write_tokens : 0
  const consistent =
    cachedTokens <= usage.input_tokens &&
    (cacheWriteTokens ?? 0) <= usage.input_tokens - cachedTokens
  if (!consistent || (explicitCache && cacheWriteTokens === undefined)) {
    // The answer already exists (and may already be streamed to a guest), so
    // unusable cache detail must not fail it. Bill every uncertain input token
    // at the dearest rate the request could incur: cache writes for explicit
    // caching (priced at least as ordinary input), ordinary input otherwise
    // (some providers price writes at zero). Contradictory reads earn no discount.
    const cacheReadInputTokens = consistent ? cachedTokens : 0
    const uncertain = usage.input_tokens - cacheReadInputTokens
    return {
      inputTokens: explicitCache ? 0 : uncertain,
      outputTokens: usage.output_tokens,
      cacheCreationInputTokens: explicitCache ? uncertain : 0,
      cacheReadInputTokens,
    }
  }
  const cacheCreationInputTokens = cacheWriteTokens ?? 0
  return {
    inputTokens: usage.input_tokens - cachedTokens - cacheCreationInputTokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens,
    cacheReadInputTokens: cachedTokens,
  }
}

const OPENAI_RESPONSES_PROVIDER_CONFIG: Record<
  OpenAiResponsesProviderId,
  { envKey: string; baseURL?: string }
> = {
  openai: {
    envKey: 'OPENAI_API_KEY',
  },
  // This endpoint is intentionally literal rather than configuration: accepting
  // a runtime base URL would turn provider routing into an SSRF/egress boundary.
  deepseek: {
    envKey: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com',
  },
} as const

const openAiResponsesClients = new Map<OpenAiResponsesProviderId, OpenAiResponsesClient>()

export class OpenAiIncompleteResponseError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`OpenAI response was incomplete: ${reason}`)
    this.name = 'OpenAiIncompleteResponseError'
    this.reason = reason
  }
}

export class OpenAiResponsesProviderConfigurationError extends Error {
  constructor(readonly code: 'provider-not-configured' | 'provider-client-initialization') {
    super('AI provider configuration is unavailable')
    this.name = 'OpenAiResponsesProviderConfigurationError'
  }
}

function openAiResponsesProviderId(provider: AiTextProviderId): OpenAiResponsesProviderId {
  if (provider === 'openai' || provider === 'deepseek') return provider
  throw new Error(`Provider ${provider} does not implement the OpenAI Responses adapter`)
}

function getOpenAiResponsesClient(provider: AiTextProviderId): OpenAiResponsesClient {
  const providerId = openAiResponsesProviderId(provider)
  const existing = openAiResponsesClients.get(providerId)
  if (existing) return existing

  const configuration = OPENAI_RESPONSES_PROVIDER_CONFIG[providerId]
  const apiKey = process.env[configuration.envKey]
  if (!apiKey) throw new OpenAiResponsesProviderConfigurationError('provider-not-configured')
  try {
    const client = new OpenAI({
      apiKey,
      maxRetries: 0,
      ...(configuration.baseURL ? { baseURL: configuration.baseURL } : {}),
    }) as unknown as OpenAiResponsesClient
    openAiResponsesClients.set(providerId, client)
    return client
  } catch {
    throw new OpenAiResponsesProviderConfigurationError('provider-client-initialization')
  }
}

/** Resolves the fixed provider client without dispatching or reserving spend. */
export function assertOpenAiResponsesProviderReady(provider: AiTextProviderId): void {
  getOpenAiResponsesClient(provider)
}

export function setOpenAiResponsesClientForTesting(
  client: OpenAiResponsesClient | null,
  provider?: OpenAiResponsesProviderId,
): void {
  if (provider) {
    if (client) openAiResponsesClients.set(provider, client)
    else openAiResponsesClients.delete(provider)
    return
  }
  openAiResponsesClients.clear()
  if (client) openAiResponsesClients.set('openai', client)
}

export async function createOpenAiTextResponse(params: {
  spec: AiModelSpec
  system: AiSystemBlock[]
  messages: AiMessage[]
  maxOutputTokens: number
  timeoutMs: number
  signal?: AbortSignal
}): Promise<{ text: string; usage: AiTokenUsage; incomplete?: boolean }> {
  const prompt = promptInput(
    params.spec.provider,
    params.spec.model,
    params.system,
    params.messages,
  )
  const raw = await getOpenAiResponsesClient(params.spec.provider).responses.create(
    {
      model: params.spec.model,
      ...prompt,
      max_output_tokens: params.maxOutputTokens,
      reasoning: { effort: reasoningEffort(params.spec.model) },
      store: false,
    },
    { timeout: params.timeoutMs, ...(params.signal ? { signal: params.signal } : {}) },
  )
  const response = openAiResponseSchema.parse(raw)
  const incomplete =
    (response.status !== undefined && response.status !== 'completed') ||
    Boolean(response.incomplete_details)
  if (!response.usage) {
    if (incomplete) {
      throw new OpenAiIncompleteResponseError(response.incomplete_details?.reason ?? 'unspecified')
    }
    throw new Error('OpenAI response did not include usage')
  }
  const text =
    response.output_text?.trim() ||
    (response.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
      .trim()
  return {
    ...(incomplete ? { incomplete: true as const } : {}),
    text,
    usage: tokenUsage(response.usage, hasExplicitBreakpoint(prompt)),
  }
}

export async function createOpenAiTextStream(params: {
  spec: AiModelSpec
  system: AiSystemBlock[]
  messages: AiMessage[]
  maxOutputTokens: number
  timeoutMs: number
  onTextDelta: (delta: string) => void | Promise<void>
  signal?: AbortSignal
}): Promise<{ text: string; usage: AiTokenUsage; incomplete?: boolean }> {
  const prompt = promptInput(
    params.spec.provider,
    params.spec.model,
    params.system,
    params.messages,
  )
  const raw = await getOpenAiResponsesClient(params.spec.provider).responses.create(
    {
      model: params.spec.model,
      ...prompt,
      max_output_tokens: params.maxOutputTokens,
      reasoning: { effort: reasoningEffort(params.spec.model) },
      store: false,
      stream: true,
    },
    { timeout: params.timeoutMs, ...(params.signal ? { signal: params.signal } : {}) },
  )
  if (!raw || typeof raw !== 'object' || !(Symbol.asyncIterator in raw)) {
    throw new Error('OpenAI streaming response was not async iterable')
  }

  let completedResponse: z.infer<typeof openAiResponseSchema> | null = null
  let terminalType: 'response.completed' | 'response.incomplete' | 'response.failed' | null = null
  let streamedText = ''
  for await (const rawEvent of raw as OpenAiResponseStream) {
    const event = openAiStreamEventSchema.safeParse(rawEvent)
    if (!event.success) continue
    if (event.data.type === 'response.output_text.delta') {
      if (!event.data.delta) continue
      streamedText += event.data.delta
      await params.onTextDelta(event.data.delta)
      continue
    }
    completedResponse = event.data.response
    terminalType = event.data.type
  }

  if (!completedResponse) throw new Error('OpenAI stream ended without a terminal response')
  const incomplete =
    terminalType === 'response.incomplete' ||
    terminalType === 'response.failed' ||
    (completedResponse.status !== undefined && completedResponse.status !== 'completed') ||
    Boolean(completedResponse.incomplete_details)
  if (!completedResponse.usage) {
    if (incomplete) {
      throw new OpenAiIncompleteResponseError(
        completedResponse.incomplete_details?.reason ?? 'unspecified',
      )
    }
    throw new Error('OpenAI terminal response did not include usage')
  }
  const finalText =
    completedResponse.output_text?.trim() ||
    (completedResponse.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
      .trim() ||
    streamedText.trim()
  return {
    ...(incomplete ? { incomplete: true as const } : {}),
    text: finalText,
    usage: tokenUsage(completedResponse.usage, hasExplicitBreakpoint(prompt)),
  }
}
