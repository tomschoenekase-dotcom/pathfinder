import { assertLocalLunaPlannerProfile, localLunaPricingVersion, LocalLunaPlannerExecutionError, type LocalLunaPlannerProfile, type LocalLunaTierReceipt } from './local-luna-planner-profile'
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import { z } from 'zod'
import { classifyProviderFailure, type ProviderDiagnostics } from './provider-diagnostics'

import type { AiAdmissionGuard } from './admission'
import {
  assertOpenAiResponsesProviderReady,
  createOpenAiTextResponse,
  createOpenAiTextStream,
  OpenAiIncompleteResponseError,
  OpenAiResponsesProviderConfigurationError,
} from './openai-text'

import {
  createAiInvocationId,
  observedAiCostUnits,
  textAttemptCostCeilingUnits,
  type AiBudgetGate,
  type AiBudgetReservationRef,
} from './budget'
import { getAiModelSpec, type AiModelKey, type AiTextProviderId } from './model-registry'

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
    create: (
      params: AnthropicCreateParams,
      options?: { timeout?: number; signal?: AbortSignal },
    ) => Promise<unknown>
    stream?: (
      params: AnthropicCreateParams,
      options?: { timeout?: number; signal?: AbortSignal },
    ) => AsyncIterable<unknown> & { finalMessage: () => Promise<unknown> }
  }
}

export type AiTokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  audioInputTokens?: number
  audioOutputTokens?: number
  cachedAudioInputTokens?: number
}

export type AiTextResult<TParsed = string> = {
  serviceTier?: LocalLunaTierReceipt
  text: string
  parsed: TParsed
  provider: AiTextProviderId
  model: string
  pricingVersion: string
  usage: AiTokenUsage
  estimatedCostUsd: number
  latencyMs: number
  attempts: number
}

export type AiUsageRecord = {
  serviceTier?: LocalLunaTierReceipt
  providerResponseId?: string
  costObservationStatus?: 'OBSERVED' | 'UNKNOWN'
  provider: AiTextProviderId | 'google'
  model: string
  pricingVersion: string
  usage: AiTokenUsage
  estimatedCostUsd: number
  latencyMs: number
  attempts: number
  success: boolean
  errorCode?: string
  providerFailureCode?: ProviderDiagnostics['code']
  providerHttpStatus?: number | null
  providerErrorCode?: ProviderDiagnostics['providerCode']
  capability?: string
  requestType?: string
  routeModelKey?: string
  fallbackUsed?: boolean
  /** Absent is reserved for legacy producers and must never be interpreted as observed. */
  usageObservationStatus?: 'OBSERVED' | 'UNKNOWN' | 'NOT_DISPATCHED'
}

export type AiUsageSink = (record: AiUsageRecord) => Promise<void>

export class AiGatewayError extends Error {
  readonly diagnostics: ProviderDiagnostics
  readonly attempts: number
  readonly code: string
  readonly usageRecorded: boolean
  readonly textEmitted: boolean

  constructor(
    message: string,
    options: {
      attempts: number
      code: string
      cause?: unknown
      usageRecorded?: boolean
      textEmitted?: boolean
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'AiGatewayError'
    this.diagnostics = classifyProviderFailure({ code: options.code, cause: options.cause })
    this.attempts = options.attempts
    this.code = ['PROVIDER_CREDITS_EXHAUSTED', 'PROVIDER_RATE_LIMITED'].includes(this.diagnostics.code)
      ? this.diagnostics.code
      : options.code
    this.usageRecorded = options.usageRecorded ?? false
    this.textEmitted = options.textEmitted ?? false
  }
}

const responseSchema = z.object({
  stop_reason: z.string().nullable().optional(),
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
    if (!apiKey) {
      throw new AiGatewayError('AI provider configuration is unavailable', {
        attempts: 0,
        code: 'provider-not-configured',
      })
    }
    try {
      anthropicClient = new Anthropic({
        apiKey,
        maxRetries: 0,
      }) as unknown as AnthropicMessagesClient
    } catch (cause) {
      throw new AiGatewayError('AI provider client could not be initialized', {
        attempts: 0,
        code: 'provider-client-initialization',
        cause,
      })
    }
  }
  return anthropicClient as AnthropicMessagesClient
}

export function setAnthropicClientForTesting(client: AnthropicMessagesClient | null): void {
  anthropicClient = client
}

function isIncompleteAnthropicResponse(stopReason: string | null | undefined): boolean {
  // Legacy response fixtures omit this metadata. An explicit non-terminal
  // reason (including null) must never be accepted as a completed text answer.
  return (
    stopReason !== undefined && !['end_turn', 'stop_sequence', 'refusal'].includes(stopReason ?? '')
  )
}

async function createProviderResponse(params: {
  spec: ReturnType<typeof getAiModelSpec>
  system: AiSystemBlock[]
  messages: AiMessage[]
  maxOutputTokens: number
  timeoutMs: number
  onTextDelta?: (delta: string) => void | Promise<void>
  invocationProfile?: LocalLunaPlannerProfile
  signal?: AbortSignal
}): Promise<{ text: string; usage: AiTokenUsage; incomplete?: boolean; serviceTier?: LocalLunaTierReceipt }> {
  const options = { timeout: params.timeoutMs, ...(params.signal ? { signal: params.signal } : {}) }
  switch (params.spec.provider) {
    case 'openai':
    case 'deepseek':
      return params.onTextDelta
        ? createOpenAiTextStream({ ...params, onTextDelta: params.onTextDelta })
        : createOpenAiTextResponse(params)
    case 'anthropic':
      break
    default: {
      const impossible: never = params.spec.provider
      throw new Error(`No text provider adapter is registered for ${impossible}`)
    }
  }

  if (params.onTextDelta) {
    const client = getAnthropicClient()
    if (!client.messages.stream) throw new Error('Anthropic streaming is unavailable')
    const stream = client.messages.stream(
      {
        model: params.spec.model,
        max_tokens: params.maxOutputTokens,
        system: params.system,
        messages: params.messages,
      },
      options,
    )
    for await (const rawEvent of stream) {
      const event = z
        .object({
          type: z.string(),
          delta: z.object({ type: z.string(), text: z.string().optional() }).optional(),
        })
        .passthrough()
        .safeParse(rawEvent)
      if (
        event.success &&
        event.data.type === 'content_block_delta' &&
        event.data.delta?.type === 'text_delta' &&
        event.data.delta.text
      ) {
        await params.onTextDelta(event.data.delta.text)
      }
    }
    const response = responseSchema.parse(await stream.finalMessage())
    return {
      incomplete: isIncompleteAnthropicResponse(response.stop_reason),
      text: response.content
        .filter(
          (block): block is typeof block & { text: string } =>
            block.type === 'text' && typeof block.text === 'string',
        )
        .map((block) => block.text)
        .join('\n')
        .trim(),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    }
  }

  const raw = await getAnthropicClient().messages.create(
    {
      model: params.spec.model,
      max_tokens: params.maxOutputTokens,
      system: params.system,
      messages: params.messages,
    },
    options,
  )
  const response = responseSchema.parse(raw)
  return {
    incomplete: isIncompleteAnthropicResponse(response.stop_reason),
    text: response.content
      .filter(
        (block): block is typeof block & { text: string } =>
          block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('\n')
      .trim(),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    },
  }
}

function estimateCostUsd(modelKey: AiModelKey, usage: AiTokenUsage, pricing = getAiModelSpec(modelKey).pricingUsdPerMillionTokens): number {
  return (
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheCreationInputTokens * pricing.cacheWrite +
      usage.cacheReadInputTokens * pricing.cacheRead) /
    1_000_000
  )
}

function isRetryable(error: unknown): boolean {
  const diagnostics = classifyProviderFailure(error)
  if (diagnostics.code === 'PROVIDER_CREDITS_EXHAUSTED') return false
  if (diagnostics.retryable) return true
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
  const diagnostics = classifyProviderFailure(error)
  if (diagnostics.code === 'PROVIDER_CREDITS_EXHAUSTED' || diagnostics.code === 'PROVIDER_RATE_LIMITED') return diagnostics.code
  if (error instanceof z.ZodError) return 'invalid-provider-response'
  if (error instanceof OpenAiIncompleteResponseError) return 'provider-incomplete-response'
  if (error instanceof APIConnectionTimeoutError) return 'provider-connection-timeout'
  if (error instanceof APIConnectionError) return 'provider-connection-error'
  if (error instanceof APIUserAbortError) return 'provider-user-abort'
  if (error && typeof error === 'object') {
    const status = 'status' in error ? (error as { status?: unknown }).status : undefined
    const name = 'name' in error ? (error as { name?: unknown }).name : undefined
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return `provider-http-${status}`
    if (name === 'AbortError' || name === 'TimeoutError') return name
  }
  return 'provider-error'
}

function failureMetadata(error: unknown) {
  const diagnostics = classifyProviderFailure(error)
  return { providerFailureCode: diagnostics.code, providerHttpStatus: diagnostics.httpStatus, providerErrorCode: diagnostics.providerCode }
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

export async function generateText<TParsed = string>(params: {
  invocationProfile?: LocalLunaPlannerProfile
  modelKey: AiModelKey
  system: AiSystemBlock[]
  messages: AiMessage[]
  maxOutputTokens?: number
  timeoutMs?: number
  maxAttempts?: number
  retryDelayMs?: number
  usageSink: AiUsageSink
  admissionGuard: AiAdmissionGuard
  budgetGate: AiBudgetGate
  parseResponse?: (text: string) => TParsed
  invocationId?: string
  /** Internal routed-execution offset so one invocation has unique budget attempt identities. */
  budgetAttemptNumberOffset?: number
  onBeforeFirstDispatch?: () => Promise<void>
  onTextDelta?: (delta: string) => void | Promise<void>
  signal?: AbortSignal
}): Promise<AiTextResult<TParsed>> {
  const profile = params.invocationProfile
  const modelKey = params.modelKey
  const spec = profile ? structuredClone(getAiModelSpec(modelKey)) : getAiModelSpec(modelKey)
  const system = profile ? structuredClone(params.system) : params.system
  const messages = profile ? structuredClone(params.messages) : params.messages
  const maxAttempts = params.maxAttempts ?? spec.maxAttempts
  const timeoutMs = params.timeoutMs ?? spec.timeoutMs
  const startedAt = performance.now()
  const invocationId = params.invocationId ?? createAiInvocationId()
  const budgetGate = params.budgetGate
  let lastError: unknown
  let dispatchRecorded = false
  let textEmitted = false

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer')
  }
  const budgetAttemptNumberOffset = params.budgetAttemptNumberOffset ?? 0
  if (!Number.isInteger(budgetAttemptNumberOffset) || budgetAttemptNumberOffset < 0) {
    throw new Error('budgetAttemptNumberOffset must be a nonnegative integer')
  }
  const maxOutputTokens = params.maxOutputTokens ?? spec.maxOutputTokens
  if (profile !== undefined) assertLocalLunaPlannerProfile(profile, spec, { maxAttempts, maxOutputTokens, streaming: Boolean(params.onTextDelta), explicitCache: system.some(block => block.cache_control?.type === 'ephemeral') })
  const attemptPricingVersion = profile ? localLunaPricingVersion(spec.pricingVersion, profile) : spec.pricingVersion
  let profileUsageAttempted = false
  const recordUsage = async (record: AiUsageRecord) => {
    if (!profile) return recordUsageBestEffort(params.usageSink, record)
    profileUsageAttempted = true
    try { await params.usageSink(record) } catch { throw new LocalLunaPlannerExecutionError('PLANNER_ACCOUNTING_FAILED') }
  }
  const reservedUnits = textAttemptCostCeilingUnits({
    spec,
    system,
    messages,
    maxOutputTokens,
    ...(profile ? { invocationProfile: profile } : {}),
  })
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (params.signal?.aborted) throw abortReason(params.signal)
    try {
      await params.admissionGuard()
    } catch (admissionError) {
      if (lastError !== undefined) {
        await recordUsage({
          usageObservationStatus: 'NOT_DISPATCHED',
          provider: spec.provider,
          model: spec.model,
          pricingVersion: attemptPricingVersion,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          estimatedCostUsd: 0,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          attempts: attempt - 1,
          success: false,
          errorCode: errorCode(lastError),
          ...failureMetadata(lastError),
        })
      }
      throw admissionError
    }
    // Local client setup cannot spend. Resolve it after admission, before claiming
    // a dispatch or reserving spend, so missing configuration stays undispatched.
    if (!dispatchRecorded) {
      try {
        switch (spec.provider) {
          case 'anthropic': {
            const client = getAnthropicClient()
            if (params.onTextDelta && !client.messages.stream) {
              throw new AiGatewayError('AI provider streaming client is unavailable', {
                attempts: 0,
                code: 'provider-client-initialization',
              })
            }
            break
          }
          case 'openai':
          case 'deepseek':
            assertOpenAiResponsesProviderReady(spec.provider)
            break
          default: {
            const impossible: never = spec.provider
            throw new Error(`No text provider adapter is registered for ${impossible}`)
          }
        }
      } catch (error) {
        const providerError =
          error instanceof OpenAiResponsesProviderConfigurationError
            ? new AiGatewayError('AI provider configuration is unavailable', {
                attempts: 0,
                code: error.code,
                cause: error,
              })
            : error
        if (!(providerError instanceof AiGatewayError)) throw providerError
        await recordUsage({
          usageObservationStatus: 'NOT_DISPATCHED',
          provider: spec.provider,
          model: spec.model,
          pricingVersion: attemptPricingVersion,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          estimatedCostUsd: 0,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          attempts: 0,
          success: false,
          errorCode: providerError.code,
          ...failureMetadata(providerError),
        })
        throw new AiGatewayError(providerError.message, {
          attempts: 0,
          code: providerError.code,
          usageRecorded: true,
          cause: providerError,
        })
      }
    }
    const reservation = await budgetGate.reserve({
      invocationId,
      attemptNumber: budgetAttemptNumberOffset + attempt,
      provider: spec.provider,
      model: spec.model,
      pricingVersion: attemptPricingVersion,
      reservedUnits,
    })
    try {
      await params.admissionGuard()
    } catch (admissionError) {
      if (reservation) await budgetGate.releaseUndispatched(reservation)
      throw admissionError
    }
    if (!dispatchRecorded) {
      try {
        await params.onBeforeFirstDispatch?.()
      } catch (dispatchFenceError) {
        if (reservation) await budgetGate.releaseUndispatched(reservation)
        throw dispatchFenceError
      }
      dispatchRecorded = true
    }
    if (reservation) {
      try {
        await budgetGate.markDispatched(reservation)
      } catch (accountingError) {
        try {
          await budgetGate.releaseUndispatched(reservation)
        } catch {
          // Preserve the original pre-provider accounting failure.
        }
        throw accountingError
      }
    }
    let observedReservation: AiBudgetReservationRef | null = null
    try {
      const response = await createProviderResponse({
        spec,
        ...(profile ? { invocationProfile: profile } : {}),
        system,
        messages,
        maxOutputTokens,
        timeoutMs,
        ...(params.onTextDelta
          ? {
              onTextDelta: async (delta: string) => {
                if (!delta) return
                textEmitted = true
                await params.onTextDelta?.(delta)
              },
            }
          : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      })
      if (params.signal?.aborted) throw abortReason(params.signal)
      const usage = response.usage
      const tier = response.serviceTier ? Object.freeze(structuredClone(response.serviceTier)) : undefined
      if (profile && (!tier || tier.rateMultiplier === null)) {
        await recordUsage({ usageObservationStatus: 'OBSERVED', costObservationStatus: 'UNKNOWN',
          provider: spec.provider, model: spec.model, pricingVersion: localLunaPricingVersion(spec.pricingVersion, profile, 'tier-unknown'),
          usage, estimatedCostUsd: 0, latencyMs: Math.max(0, Math.round(performance.now() - startedAt)), attempts: attempt,
          success: false, errorCode: 'UNKNOWN_SERVICE_TIER', ...(tier ? { serviceTier: tier } : {}),
          ...(tier?.providerResponseId ? { providerResponseId: tier.providerResponseId } : {}),
        })
        throw new LocalLunaPlannerExecutionError('UNKNOWN_SERVICE_TIER')
      }
      const observedCost = estimateCostUsd(modelKey, usage, profile ? spec.pricingUsdPerMillionTokens : undefined) * (profile ? tier!.rateMultiplier! : 1)
      const observedPricingVersion = profile ? localLunaPricingVersion(spec.pricingVersion, profile, tier!.observedTier!) : spec.pricingVersion
      const observation = profile ? { serviceTier: tier!, costObservationStatus: 'OBSERVED' as const, ...(tier!.providerResponseId ? { providerResponseId: tier!.providerResponseId } : {}) } : {}
      observedReservation = reservation
      if (reservation) {
        try {
          await budgetGate.settleExact(
            reservation,
            observedAiCostUnits(observedCost),
          )
        } catch {
          if (profile) {
            await recordUsage({ ...observation, usageObservationStatus: 'OBSERVED', provider: spec.provider, model: spec.model,
              pricingVersion: observedPricingVersion, usage, estimatedCostUsd: observedCost, latencyMs: Math.max(0, Math.round(performance.now() - startedAt)), attempts: attempt, success: false, errorCode: 'PLANNER_ACCOUNTING_FAILED' })
            throw new LocalLunaPlannerExecutionError('PLANNER_ACCOUNTING_FAILED')
          }
          // The durable reservation remains fully held. A settlement outage
          // must not turn one provider response into another provider attempt.
        }
      }
      if (profile && (!tier!.providerResponseId || tier!.outcome === 'UNEXPECTED_FAST_TIER')) {
        const code = !tier!.providerResponseId ? 'MISSING_PROVIDER_RESPONSE_ID' as const : 'UNEXPECTED_FAST_TIER' as const
        await recordUsage({ ...observation, usageObservationStatus: 'OBSERVED', provider: spec.provider, model: spec.model,
          pricingVersion: observedPricingVersion, usage, estimatedCostUsd: observedCost, latencyMs: Math.max(0, Math.round(performance.now() - startedAt)), attempts: attempt, success: false, errorCode: code })
        throw new LocalLunaPlannerExecutionError(code)
      }
      const text = response.text
      if (response.incomplete || !text) {
        const gatewayError = new AiGatewayError(
          response.incomplete
            ? 'Provider response did not complete'
            : 'Provider response contained no text block',
          {
            attempts: attempt,
            code: response.incomplete ? 'provider-incomplete-response' : 'missing-text-block',
            usageRecorded: true,
          },
        )
        await recordUsage({
          ...observation,
          usageObservationStatus: 'OBSERVED',
          provider: spec.provider,
          model: spec.model,
          pricingVersion: observedPricingVersion,
          usage,
          estimatedCostUsd: observedCost,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          attempts: attempt,
          success: false,
          errorCode: gatewayError.code,
            providerFailureCode: gatewayError.diagnostics.code,
            providerHttpStatus: gatewayError.diagnostics.httpStatus,
            providerErrorCode: gatewayError.diagnostics.providerCode,
        })
        throw gatewayError
      }

      let parsed: TParsed
      try {
        parsed = params.parseResponse ? params.parseResponse(text) : (text as TParsed)
      } catch (error) {
        const gatewayError = new AiGatewayError(
          error instanceof Error ? error.message : 'Structured response validation failed',
          {
            attempts: attempt,
            code: 'invalid-structured-output',
            cause: error,
            usageRecorded: true,
          },
        )
        await recordUsage({
          ...observation,
          usageObservationStatus: 'OBSERVED',
          provider: spec.provider,
          model: spec.model,
          pricingVersion: observedPricingVersion,
          usage,
          estimatedCostUsd: observedCost,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          attempts: attempt,
          success: false,
          errorCode: gatewayError.code,
            providerFailureCode: gatewayError.diagnostics.code,
            providerHttpStatus: gatewayError.diagnostics.httpStatus,
            providerErrorCode: gatewayError.diagnostics.providerCode,
        })
        throw gatewayError
      }
      const result: AiTextResult<TParsed> = {
        ...(profile ? { serviceTier: tier! } : {}),
        text,
        parsed,
        provider: spec.provider,
        model: spec.model,
        pricingVersion: observedPricingVersion,
        usage,
        estimatedCostUsd: observedCost,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        attempts: attempt,
      }
      await recordUsage({
        ...observation,
        usageObservationStatus: 'OBSERVED',
        provider: result.provider,
        model: result.model,
        pricingVersion: result.pricingVersion,
        usage: result.usage,
        estimatedCostUsd: result.estimatedCostUsd,
        latencyMs: result.latencyMs,
        attempts: result.attempts,
        success: true,
      })
      return result
    } catch (error) {
      if (reservation && !observedReservation) {
        try {
          await budgetGate.settleAmbiguous(reservation)
        } catch {
          // The unresolved reservation already conservatively consumes its
          // full ceiling and remains recoverable without another dispatch.
        }
      }
      if (profile) {
        if (!profileUsageAttempted) await recordUsage({ usageObservationStatus: 'UNKNOWN', costObservationStatus: 'UNKNOWN',
          provider: spec.provider, model: spec.model, pricingVersion: localLunaPricingVersion(spec.pricingVersion, profile, 'usage-unknown'),
          usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, estimatedCostUsd: 0,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)), attempts: attempt, success: false,
          errorCode: error instanceof LocalLunaPlannerExecutionError ? error.code : 'PLANNER_OPERATION_FAILED' })
        if (error instanceof LocalLunaPlannerExecutionError) throw error
        throw new LocalLunaPlannerExecutionError('PLANNER_OPERATION_FAILED')
      }
      lastError = error
      if (params.signal?.aborted) throw abortReason(params.signal)
      if (attempt >= maxAttempts || !isRetryable(error)) {
        const gatewayError = new AiGatewayError(
          'AI provider request failed',
          {
            attempts: attempt,
            code: error instanceof AiGatewayError ? error.code : errorCode(error),
            cause: error,
            textEmitted,
          },
        )
        if (!(error instanceof AiGatewayError && error.usageRecorded)) {
          await recordUsage({
            usageObservationStatus: 'UNKNOWN',
            provider: spec.provider,
            model: spec.model,
            pricingVersion: attemptPricingVersion,
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
            providerFailureCode: gatewayError.diagnostics.code,
            providerHttpStatus: gatewayError.diagnostics.httpStatus,
            providerErrorCode: gatewayError.diagnostics.providerCode,
          })
        }
        throw gatewayError
      }
      if (textEmitted) {
        const gatewayError = new AiGatewayError(
          'AI provider stream failed',
          {
            attempts: attempt,
            code: error instanceof AiGatewayError ? error.code : errorCode(error),
            cause: error,
            textEmitted: true,
          },
        )
        if (!(error instanceof AiGatewayError && error.usageRecorded)) {
          await recordUsage({
            usageObservationStatus: 'UNKNOWN',
            provider: spec.provider,
            model: spec.model,
            pricingVersion: attemptPricingVersion,
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
            providerFailureCode: gatewayError.diagnostics.code,
            providerHttpStatus: gatewayError.diagnostics.httpStatus,
            providerErrorCode: gatewayError.diagnostics.providerCode,
          })
        }
        throw gatewayError
      }
      if (!(error instanceof AiGatewayError && error.usageRecorded)) {
        await recordUsage({
          usageObservationStatus: 'UNKNOWN',
          provider: spec.provider,
          model: spec.model,
          pricingVersion: attemptPricingVersion,
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
          errorCode: error instanceof AiGatewayError ? error.code : errorCode(error),
          ...failureMetadata(error),
        })
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

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}
