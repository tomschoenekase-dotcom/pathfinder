import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import { z } from 'zod'

import { getAiModelSpec, type AiModelKey } from './model-registry'

export type AiSystemBlock = {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

export type AiMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type AnthropicCreateParams = {
  model: string
  max_tokens: number
  system: AiSystemBlock[]
  messages: AiMessage[]
}

export type AnthropicMessagesClient = {
  messages: {
    create: (params: AnthropicCreateParams, options?: { timeout?: number }) => Promise<unknown>
  }
}

export type AiTokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export type AiTextResult = {
  text: string
  provider: 'anthropic'
  model: string
  pricingVersion: string
  usage: AiTokenUsage
  estimatedCostUsd: number
  latencyMs: number
  attempts: number
}

export type AiUsageRecord = Omit<AiTextResult, 'text'> & {
  success: boolean
  errorCode?: string
}

export type AiUsageSink = (record: AiUsageRecord) => Promise<void>

export class AiGatewayError extends Error {
  readonly attempts: number
  readonly code: string

  constructor(message: string, options: { attempts: number; code: string; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'AiGatewayError'
    this.attempts = options.attempts
    this.code = options.code
  }
}

const responseSchema = z.object({
  content: z.array(
    z
      .object({
        type: z.string(),
        text: z.string().optional(),
      })
      .passthrough(),
  ),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      cache_creation_input_tokens: z.number().int().nonnegative().optional(),
      cache_read_input_tokens: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
})

let anthropicClient: AnthropicMessagesClient | null = null

function getAnthropicClient(): AnthropicMessagesClient {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured')
    anthropicClient = new Anthropic({
      apiKey,
      maxRetries: 0,
    }) as unknown as AnthropicMessagesClient
  }
  return anthropicClient as AnthropicMessagesClient
}

export function setAnthropicClientForTesting(client: AnthropicMessagesClient | null): void {
  anthropicClient = client
}

function estimateCostUsd(modelKey: AiModelKey, usage: AiTokenUsage): number {
  const pricing = getAiModelSpec(modelKey).pricingUsdPerMillionTokens
  return (
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheCreationInputTokens * pricing.cacheWrite +
      usage.cacheReadInputTokens * pricing.cacheRead) /
    1_000_000
  )
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = 'status' in error ? (error as { status?: unknown }).status : undefined
  const name = 'name' in error ? (error as { name?: unknown }).name : undefined
  return (
    error instanceof APIConnectionError ||
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500)
  )
}

function errorCode(error: unknown): string {
  if (error instanceof z.ZodError) return 'invalid-provider-response'
  if (error instanceof APIConnectionTimeoutError) return 'provider-connection-timeout'
  if (error instanceof APIConnectionError) return 'provider-connection-error'
  if (error instanceof APIUserAbortError) return 'provider-user-abort'
  if (error && typeof error === 'object') {
    const status = 'status' in error ? (error as { status?: unknown }).status : undefined
    const name = 'name' in error ? (error as { name?: unknown }).name : undefined
    if (typeof status === 'number') return `provider-http-${status}`
    if (name === 'AbortError' || name === 'TimeoutError') return name
  }
  return 'provider-error'
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function recordUsageBestEffort(sink: AiUsageSink, record: AiUsageRecord): Promise<void> {
  try {
    await sink(record)
  } catch {
    // Usage reporting must never change the guest-facing provider result.
  }
}

export async function generateText(params: {
  modelKey: AiModelKey
  system: AiSystemBlock[]
  messages: AiMessage[]
  maxOutputTokens?: number
  timeoutMs?: number
  maxAttempts?: number
  retryDelayMs?: number
  usageSink: AiUsageSink
}): Promise<AiTextResult> {
  const spec = getAiModelSpec(params.modelKey)
  const maxAttempts = params.maxAttempts ?? spec.maxAttempts
  const timeoutMs = params.timeoutMs ?? spec.timeoutMs
  const startedAt = performance.now()
  let lastError: unknown

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer')
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const raw = await getAnthropicClient().messages.create(
        {
          model: spec.model,
          max_tokens: params.maxOutputTokens ?? spec.maxOutputTokens,
          system: params.system,
          messages: params.messages,
        },
        { timeout: timeoutMs },
      )
      const response = responseSchema.parse(raw)
      const textBlock = response.content.find(
        (block): block is typeof block & { text: string } =>
          block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0,
      )
      if (!textBlock) {
        throw new AiGatewayError('Provider response contained no text block', {
          attempts: attempt,
          code: 'missing-text-block',
        })
      }

      const usage: AiTokenUsage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      }

      const result: AiTextResult = {
        text: textBlock.text,
        provider: spec.provider,
        model: spec.model,
        pricingVersion: spec.pricingVersion,
        usage,
        estimatedCostUsd: estimateCostUsd(params.modelKey, usage),
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        attempts: attempt,
      }
      await recordUsageBestEffort(params.usageSink, { ...result, success: true })
      return result
    } catch (error) {
      lastError = error
      if (attempt >= maxAttempts || !isRetryable(error)) {
        const gatewayError = new AiGatewayError(
          error instanceof Error ? error.message : 'AI provider failed',
          {
            attempts: attempt,
            code: error instanceof AiGatewayError ? error.code : errorCode(error),
            cause: error,
          },
        )
        await recordUsageBestEffort(params.usageSink, {
          provider: spec.provider,
          model: spec.model,
          pricingVersion: spec.pricingVersion,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          estimatedCostUsd: 0,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          attempts: attempt,
          success: false,
          errorCode: gatewayError.code,
        })
        throw gatewayError
      }
      await wait((params.retryDelayMs ?? 100) * 2 ** (attempt - 1))
    }
  }

  throw new AiGatewayError('AI provider failed', {
    attempts: maxAttempts,
    code: errorCode(lastError),
    cause: lastError,
  })
}
