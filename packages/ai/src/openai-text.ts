import OpenAI from 'openai'
import { z } from 'zod'

import type { AiMessage, AiSystemBlock, AiTokenUsage } from './anthropic'
import type { AiModelSpec } from './model-registry'

const openAiResponseSchema = z.object({
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
        store: false
      },
      options?: { timeout?: number; signal?: AbortSignal },
    ) => Promise<unknown>
  }
}

let openAiResponsesClient: OpenAiResponsesClient | null = null

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
      store: false,
    },
    { timeout: params.timeoutMs, ...(params.signal ? { signal: params.signal } : {}) },
  )
  const response = openAiResponseSchema.parse(raw)
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
