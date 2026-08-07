import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'openai'
import { z } from 'zod'

import { AiGatewayError, type AiTokenUsage, type AiUsageSink } from './anthropic'
import { getAiEmbeddingModelSpec, type AiEmbeddingModelKey } from './embedding-model-registry'

type EmbeddingCreateParams = {
  model: string
  input: string[]
  dimensions: number
}

export type OpenAiEmbeddingsClient = {
  embeddings: {
    create: (params: EmbeddingCreateParams, options?: { timeout?: number }) => Promise<unknown>
  }
}

export type AiEmbeddingResult = {
  embeddings: number[][]
  provider: 'openai'
  model: string
  pricingVersion: string
  usage: AiTokenUsage
  estimatedCostUsd: number
  latencyMs: number
  attempts: number
}

const responseUsageSchema = z.object({
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }),
})

const responseDataSchema = z.object({ data: z.array(z.unknown()) })

let openAiClient: OpenAiEmbeddingsClient | null = null

function getOpenAiClient(): OpenAiEmbeddingsClient {
  if (!openAiClient) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')
    openAiClient = new OpenAI({ apiKey, maxRetries: 0 }) as unknown as OpenAiEmbeddingsClient
  }
  return openAiClient
}

export function setOpenAiEmbeddingsClientForTesting(client: OpenAiEmbeddingsClient | null): void {
  openAiClient = client
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = 'status' in error ? (error as { status?: unknown }).status : undefined
  const name = 'name' in error ? (error as { name?: unknown }).name : undefined
  return (
    (!(error instanceof APIUserAbortError) && error instanceof APIConnectionError) ||
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500)
  )
}

function providerErrorCode(error: unknown): string {
  if (error instanceof APIConnectionTimeoutError) return 'provider-connection-timeout'
  if (error instanceof APIUserAbortError) return 'provider-user-abort'
  if (error instanceof APIConnectionError) return 'provider-connection-error'
  if (error && typeof error === 'object') {
    const status = 'status' in error ? (error as { status?: unknown }).status : undefined
    const name = 'name' in error ? (error as { name?: unknown }).name : undefined
    if (typeof status === 'number') return `provider-http-${status}`
    if (typeof name === 'string' && name.length > 0) return `provider-${name}`
  }
  return 'provider-error'
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function recordUsageBestEffort(
  sink: AiUsageSink,
  record: Parameters<AiUsageSink>[0],
): Promise<void> {
  try {
    await sink(record)
  } catch {
    // Usage persistence must not change provider or guest-facing behavior.
  }
}

function zeroUsage(): AiTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }
}

function validateEmbeddings(data: unknown[], count: number, dimensions: number): number[][] {
  const itemSchema = z.object({
    index: z.number().int().min(0),
    embedding: z.array(z.number().finite()).length(dimensions),
  })
  const items = z.array(itemSchema).length(count).parse(data)
  const byIndex = new Map(items.map((item) => [item.index, item.embedding]))
  if (byIndex.size !== count || [...byIndex.keys()].some((index) => index >= count)) {
    throw new Error('Embedding response indexes did not match the request')
  }
  return Array.from({ length: count }, (_, index) => {
    const embedding = byIndex.get(index)
    if (!embedding) throw new Error(`Embedding response omitted index ${index}`)
    return embedding
  })
}

export async function generateEmbeddings(params: {
  modelKey: AiEmbeddingModelKey
  texts: string[]
  usageSink: AiUsageSink
  timeoutMs?: number
  maxAttempts?: number
  retryDelayMs?: number
}): Promise<AiEmbeddingResult> {
  if (params.texts.length === 0 || params.texts.some((text) => text.trim().length === 0)) {
    throw new Error('Embedding input must contain nonblank text')
  }

  const spec = getAiEmbeddingModelSpec(params.modelKey)
  const timeoutMs = params.timeoutMs ?? spec.timeoutMs
  const maxAttempts = params.maxAttempts ?? spec.maxAttempts
  const retryDelayMs = params.retryDelayMs ?? 100
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive finite number')
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('retryDelayMs must be a nonnegative finite number')
  }
  const startedAt = performance.now()
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const raw = await getOpenAiClient().embeddings.create(
        { model: spec.model, input: params.texts, dimensions: spec.dimensions },
        { timeout: timeoutMs },
      )
      const observed = responseUsageSchema.parse(raw)
      const usage: AiTokenUsage = {
        inputTokens: observed.usage.prompt_tokens,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }
      const estimatedCostUsd = (usage.inputTokens * spec.inputUsdPerMillionTokens) / 1_000_000

      try {
        const data = responseDataSchema.parse(raw).data
        const embeddings = validateEmbeddings(data, params.texts.length, spec.dimensions)
        const result: AiEmbeddingResult = {
          embeddings,
          provider: 'openai',
          model: spec.model,
          pricingVersion: spec.pricingVersion,
          usage,
          estimatedCostUsd,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          attempts: attempt,
        }
        await recordUsageBestEffort(params.usageSink, { ...result, success: true })
        return result
      } catch (error) {
        await recordUsageBestEffort(params.usageSink, {
          provider: 'openai',
          model: spec.model,
          pricingVersion: spec.pricingVersion,
          usage,
          estimatedCostUsd,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          attempts: attempt,
          success: false,
          errorCode: 'invalid-provider-response',
        })
        throw new AiGatewayError('OpenAI returned invalid embedding data', {
          attempts: attempt,
          code: 'invalid-provider-response',
          cause: error,
          usageRecorded: true,
        })
      }
    } catch (error) {
      if (error instanceof AiGatewayError && error.usageRecorded) throw error
      lastError = error
      if (attempt < maxAttempts && isRetryable(error)) {
        await wait(retryDelayMs * attempt)
        continue
      }

      const code =
        error instanceof z.ZodError ? 'invalid-provider-response' : providerErrorCode(error)
      await recordUsageBestEffort(params.usageSink, {
        provider: 'openai',
        model: spec.model,
        pricingVersion: spec.pricingVersion,
        usage: zeroUsage(),
        estimatedCostUsd: 0,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        attempts: attempt,
        success: false,
        errorCode: code,
      })
      throw new AiGatewayError('OpenAI embedding request failed', {
        attempts: attempt,
        code,
        cause: error,
        usageRecorded: true,
      })
    }
  }

  throw lastError
}

export async function generateEmbedding(params: {
  modelKey: AiEmbeddingModelKey
  text: string
  usageSink: AiUsageSink
  timeoutMs?: number
  maxAttempts?: number
  retryDelayMs?: number
}): Promise<AiEmbeddingResult & { embedding: number[] }> {
  const result = await generateEmbeddings({
    modelKey: params.modelKey,
    texts: [params.text],
    usageSink: params.usageSink,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.maxAttempts !== undefined ? { maxAttempts: params.maxAttempts } : {}),
    ...(params.retryDelayMs !== undefined ? { retryDelayMs: params.retryDelayMs } : {}),
  })
  return { ...result, embedding: result.embeddings[0]! }
}
