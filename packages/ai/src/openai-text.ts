import OpenAI from 'openai'
import { z } from 'zod'

import type { AiMessage, AiSystemBlock, AiTokenUsage } from './anthropic'
import type { AiModelSpec } from './model-registry'

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
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    input_tokens_details: z
      .object({ cached_tokens: z.number().int().nonnegative().optional() })
      .passthrough()
      .optional(),
  }),
})

export type OpenAiResponsesClient = {
  responses: {
    create: (
      params: {
        model: string
        instructions: string
        input: AiMessage[]
        max_output_tokens: number
        reasoning: { effort: 'minimal' }
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

let openAiResponsesClient: OpenAiResponsesClient | null = null

export class OpenAiIncompleteResponseError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`OpenAI response was incomplete: ${reason}`)
    this.name = 'OpenAiIncompleteResponseError'
    this.reason = reason
  }
}

function getOpenAiResponsesClient(): OpenAiResponsesClient {
  if (!openAiResponsesClient) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')
    openAiResponsesClient = new OpenAI({
      apiKey,
      maxRetries: 0,
    }) as unknown as OpenAiResponsesClient
  }
  return openAiResponsesClient
}

export function setOpenAiResponsesClientForTesting(client: OpenAiResponsesClient | null): void {
  openAiResponsesClient = client
}

export async function createOpenAiTextResponse(params: {
  spec: AiModelSpec
  system: AiSystemBlock[]
  messages: AiMessage[]
  maxOutputTokens: number
  timeoutMs: number
  signal?: AbortSignal
}): Promise<{ text: string; usage: AiTokenUsage }> {
  const raw = await getOpenAiResponsesClient().responses.create(
    {
      model: params.spec.model,
      instructions: params.system.map((block) => block.text).join('\n\n'),
      input: params.messages,
      max_output_tokens: params.maxOutputTokens,
      reasoning: { effort: 'minimal' },
      store: false,
    },
    { timeout: params.timeoutMs, ...(params.signal ? { signal: params.signal } : {}) },
  )
  const response = openAiResponseSchema.parse(raw)
  if (response.status === 'incomplete' || response.incomplete_details) {
    throw new OpenAiIncompleteResponseError(response.incomplete_details?.reason ?? 'unspecified')
  }
  const cachedInputTokens = response.usage.input_tokens_details?.cached_tokens ?? 0
  const text =
    response.output_text?.trim() ||
    (response.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
      .trim()
  return {
    text,
    usage: {
      inputTokens: Math.max(0, response.usage.input_tokens - cachedInputTokens),
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: cachedInputTokens,
    },
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
}): Promise<{ text: string; usage: AiTokenUsage }> {
  const raw = await getOpenAiResponsesClient().responses.create(
    {
      model: params.spec.model,
      instructions: params.system.map((block) => block.text).join('\n\n'),
      input: params.messages,
      max_output_tokens: params.maxOutputTokens,
      reasoning: { effort: 'minimal' },
      store: false,
      stream: true,
    },
    { timeout: params.timeoutMs, ...(params.signal ? { signal: params.signal } : {}) },
  )
  if (!raw || typeof raw !== 'object' || !(Symbol.asyncIterator in raw)) {
    throw new Error('OpenAI streaming response was not async iterable')
  }

  let completedResponse: z.infer<typeof openAiResponseSchema> | null = null
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
  }

  if (!completedResponse) throw new Error('OpenAI stream ended without a terminal response')
  if (completedResponse.status === 'incomplete' || completedResponse.incomplete_details) {
    throw new OpenAiIncompleteResponseError(
      completedResponse.incomplete_details?.reason ?? 'unspecified',
    )
  }
  if (completedResponse.status && completedResponse.status !== 'completed') {
    throw new Error(`OpenAI stream ended with status ${completedResponse.status}`)
  }
  const cachedInputTokens = completedResponse.usage.input_tokens_details?.cached_tokens ?? 0
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
    text: finalText,
    usage: {
      inputTokens: Math.max(0, completedResponse.usage.input_tokens - cachedInputTokens),
      outputTokens: completedResponse.usage.output_tokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: cachedInputTokens,
    },
  }
}
