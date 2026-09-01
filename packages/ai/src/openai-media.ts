import OpenAI from 'openai'
import { z } from 'zod'

import type { AiTokenUsage, AiUsageRecord, AiUsageSink } from './anthropic'

const chatUsageSchema = z.object({
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().int().nonnegative().optional() })
      .optional(),
  }),
})

const chatCompletionSchema = chatUsageSchema.extend({
  choices: z.array(
    z
      .object({
        message: z.object({ content: z.string().nullable().optional() }).passthrough(),
      })
      .passthrough(),
  ),
})

const transcriptionUsageSchema = z.object({
  usage: z.object({
    type: z.literal('tokens'),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    input_token_details: z
      .object({
        audio_tokens: z.number().int().nonnegative().optional(),
        text_tokens: z.number().int().nonnegative().optional(),
      })
      .optional(),
  }),
})

const transcriptionSchema = transcriptionUsageSchema.extend({ text: z.string() })

export const OPENAI_MEDIA_JSON_MODEL = 'gpt-5.6-luna' as const
export const OPENAI_MEDIA_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe' as const
export const OPENAI_MEDIA_PRICING_VERSION = 'openai-public-2026-09-01' as const

const LUNA_PRICING_PER_MILLION = { input: 0.2, cachedInput: 0.02, output: 1.2 } as const
const TRANSCRIPTION_PRICING_PER_MILLION = { input: 1.25, output: 5 } as const
const LUNA_LONG_CONTEXT_INPUT_THRESHOLD = 272_000

export function resolveOpenAiMediaJsonModel(value?: string): typeof OPENAI_MEDIA_JSON_MODEL {
  if (!value) return OPENAI_MEDIA_JSON_MODEL
  if (value !== OPENAI_MEDIA_JSON_MODEL) {
    throw new Error('MEDIA_ANALYSIS_MODEL and MEDIA_SYNTHESIS_MODEL must use the reviewed model')
  }
  return value
}

export function resolveOpenAiMediaTranscriptionModel(
  value?: string,
): typeof OPENAI_MEDIA_TRANSCRIPTION_MODEL {
  if (!value) return OPENAI_MEDIA_TRANSCRIPTION_MODEL
  if (value !== OPENAI_MEDIA_TRANSCRIPTION_MODEL) {
    throw new Error('MEDIA_TRANSCRIPTION_MODEL must use the reviewed model')
  }
  return value
}

export type OpenAiMediaMessage = {
  role: 'system' | 'user'
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | {
            type: 'image_url'
            image_url: { url: string; detail: 'low' | 'high' }
          }
      >
}

export type OpenAiMediaClient = {
  chat: {
    completions: {
      create: (
        params: {
          model: string
          response_format: { type: 'json_object' }
          messages: OpenAiMediaMessage[]
        },
        options?: { signal?: AbortSignal },
      ) => Promise<unknown>
    }
  }
  audio: {
    transcriptions: {
      create: (
        params: { file: unknown; model: string },
        options?: { signal?: AbortSignal },
      ) => Promise<unknown>
    }
  }
}

let openAiMediaClient: OpenAiMediaClient | null = null

function emptyUsage(): AiTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }
}

function mediaErrorCode(error: unknown, structuredOutput = false): string {
  if (structuredOutput) return 'invalid-structured-output'
  if (error instanceof z.ZodError) return 'invalid-provider-response'
  if (error instanceof Error && error.message === 'OpenAI media JSON response was empty') {
    return 'missing-text-block'
  }
  if (error && typeof error === 'object') {
    const status = 'status' in error ? (error as { status?: unknown }).status : undefined
    const name = 'name' in error ? (error as { name?: unknown }).name : undefined
    if (typeof status === 'number') return `provider-http-${status}`
    if (name === 'AbortError' || name === 'TimeoutError') return name
  }
  return 'provider-error'
}

async function recordMediaUsage(sink: AiUsageSink, record: AiUsageRecord): Promise<void> {
  try {
    await sink(record)
  } catch {
    // Usage persistence must never alter media processing behavior.
  }
}

function lunaUsage(raw: z.infer<typeof chatUsageSchema>): AiTokenUsage {
  const cached = raw.usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    inputTokens: Math.max(0, raw.usage.prompt_tokens - cached),
    outputTokens: raw.usage.completion_tokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cached,
  }
}

function transcriptionUsage(raw: z.infer<typeof transcriptionUsageSchema>): AiTokenUsage {
  const audioInputTokens = raw.usage.input_token_details?.audio_tokens ?? raw.usage.input_tokens
  return {
    inputTokens: raw.usage.input_tokens,
    outputTokens: raw.usage.output_tokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    audioInputTokens,
    audioOutputTokens: 0,
    cachedAudioInputTokens: 0,
  }
}

function lunaCost(usage: AiTokenUsage): number {
  const longContext =
    usage.inputTokens + usage.cacheReadInputTokens > LUNA_LONG_CONTEXT_INPUT_THRESHOLD
  const inputMultiplier = longContext ? 2 : 1
  const outputMultiplier = longContext ? 1.5 : 1
  return (
    (usage.inputTokens * LUNA_PRICING_PER_MILLION.input * inputMultiplier +
      usage.cacheReadInputTokens * LUNA_PRICING_PER_MILLION.cachedInput * inputMultiplier +
      usage.outputTokens * LUNA_PRICING_PER_MILLION.output * outputMultiplier) /
    1_000_000
  )
}

function transcriptionCost(usage: AiTokenUsage): number {
  return (
    (usage.inputTokens * TRANSCRIPTION_PRICING_PER_MILLION.input +
      usage.outputTokens * TRANSCRIPTION_PRICING_PER_MILLION.output) /
    1_000_000
  )
}

function getOpenAiMediaClient(): OpenAiMediaClient {
  if (!openAiMediaClient) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')
    openAiMediaClient = new OpenAI({ apiKey, maxRetries: 0 }) as unknown as OpenAiMediaClient
  }
  return openAiMediaClient
}

export function setOpenAiMediaClientForTesting(client: OpenAiMediaClient | null): void {
  openAiMediaClient = client
}

export async function createOpenAiMediaJson<TParsed>(params: {
  model: typeof OPENAI_MEDIA_JSON_MODEL
  messages: OpenAiMediaMessage[]
  capability: 'MEDIA_ANALYSIS' | 'MEDIA_SYNTHESIS'
  parseResponse: (text: string) => TParsed
  usageSink: AiUsageSink
  signal?: AbortSignal
}): Promise<TParsed> {
  const startedAt = performance.now()
  let usage = emptyUsage()
  let structuredOutput = false
  let dispatched = false
  try {
    const client = getOpenAiMediaClient()
    dispatched = true
    const raw = await client.chat.completions.create(
      {
        model: params.model,
        response_format: { type: 'json_object' },
        messages: params.messages,
      },
      params.signal ? { signal: params.signal } : undefined,
    )
    const observedUsage = chatUsageSchema.safeParse(raw)
    if (observedUsage.success) usage = lunaUsage(observedUsage.data)
    const response = chatCompletionSchema.parse(raw)
    const text = response.choices[0]?.message.content
    if (!text) throw new Error('OpenAI media JSON response was empty')
    structuredOutput = true
    const parsed = params.parseResponse(text)
    await recordMediaUsage(params.usageSink, {
      provider: 'openai',
      model: params.model,
      pricingVersion: OPENAI_MEDIA_PRICING_VERSION,
      usage,
      estimatedCostUsd: lunaCost(usage),
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      attempts: 1,
      success: true,
      capability: params.capability,
    })
    return parsed
  } catch (error) {
    await recordMediaUsage(params.usageSink, {
      provider: 'openai',
      model: params.model,
      pricingVersion: OPENAI_MEDIA_PRICING_VERSION,
      usage,
      estimatedCostUsd: lunaCost(usage),
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      attempts: dispatched ? 1 : 0,
      success: false,
      errorCode: mediaErrorCode(error, structuredOutput),
      capability: params.capability,
    })
    throw error
  }
}

export async function transcribeOpenAiMedia(params: {
  file: unknown
  model: typeof OPENAI_MEDIA_TRANSCRIPTION_MODEL
  usageSink: AiUsageSink
  signal?: AbortSignal
}): Promise<string> {
  const startedAt = performance.now()
  let usage = emptyUsage()
  let dispatched = false
  try {
    const client = getOpenAiMediaClient()
    dispatched = true
    const raw = await client.audio.transcriptions.create(
      { file: params.file, model: params.model },
      params.signal ? { signal: params.signal } : undefined,
    )
    const observedUsage = transcriptionUsageSchema.safeParse(raw)
    if (observedUsage.success) usage = transcriptionUsage(observedUsage.data)
    const response = transcriptionSchema.parse(raw)
    await recordMediaUsage(params.usageSink, {
      provider: 'openai',
      model: params.model,
      pricingVersion: OPENAI_MEDIA_PRICING_VERSION,
      usage,
      estimatedCostUsd: transcriptionCost(usage),
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      attempts: 1,
      success: true,
      capability: 'MEDIA_TRANSCRIPTION',
    })
    return response.text
  } catch (error) {
    await recordMediaUsage(params.usageSink, {
      provider: 'openai',
      model: params.model,
      pricingVersion: OPENAI_MEDIA_PRICING_VERSION,
      usage,
      estimatedCostUsd: transcriptionCost(usage),
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      attempts: dispatched ? 1 : 0,
      success: false,
      errorCode: mediaErrorCode(error),
      capability: 'MEDIA_TRANSCRIPTION',
    })
    throw error
  }
}
