import { createHash } from 'node:crypto'
import {
  LocalLunaPlannerExecutionError,
  assertLocalLunaPlannerProfile,
  type LocalLunaPlannerProfile,
  type LocalLunaTierReceipt,
} from './local-luna-planner-profile'
import OpenAI from 'openai'
import { z } from 'zod'
import { getAiModelSpec } from './model-registry'
import { textAttemptCostCeilingUnits } from './budget'

import type { AiMessage, AiSystemBlock, AiTokenUsage } from './anthropic'
import type { AiModelSpec, AiTextProviderId } from './model-registry'

const safeTokenCount = z.number().int().nonnegative().refine(Number.isSafeInteger)

const openAiResponseSchema = z.object({
  id: z.unknown().optional(),
  service_tier: z.unknown().optional(),
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

// Exact accounting contract for the local planner only; generic legacy fallback is unchanged.
const localPlannerUsageSchema = z
  .object({
    model: z.literal('gpt-6-luna'),
    status: z.enum(['completed', 'incomplete', 'failed', 'cancelled']),
    usage: z
      .object({
        input_tokens: safeTokenCount,
        output_tokens: safeTokenCount,
        total_tokens: safeTokenCount,
        input_tokens_details: z
          .object({
            cached_tokens: safeTokenCount,
            cache_write_tokens: safeTokenCount,
            cache_write_tokens_details: z
              .object({
                ttl_30m_tokens: safeTokenCount.optional(),
                ttl_12h_tokens: safeTokenCount.optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
        output_tokens_details: z.object({ reasoning_tokens: safeTokenCount }).strict(),
      })
      .strict(),
  })
  .passthrough()
function validateLocalPlannerUsage(raw: unknown, maxOutputTokens: number, maxInputTokens: number) {
  try {
    const r = localPlannerUsageSchema.parse(raw),
      u = r.usage,
      d = u.input_tokens_details
    if (
      u.input_tokens > maxInputTokens ||
      u.output_tokens > maxOutputTokens ||
      u.total_tokens !== u.input_tokens + u.output_tokens ||
      !Number.isSafeInteger(u.total_tokens) ||
      d.cached_tokens + d.cache_write_tokens > u.input_tokens ||
      d.cache_write_tokens !== 0 ||
      (d.cache_write_tokens_details?.ttl_12h_tokens ?? 0) !== 0 ||
      (d.cache_write_tokens_details?.ttl_30m_tokens ?? 0) !== 0 ||
      u.output_tokens_details.reasoning_tokens > u.output_tokens
    )
      throw new Error('Invalid local planner usage partition')
  } catch {
    throw new LocalLunaPlannerExecutionError('INVALID_PLANNER_USAGE')
  }
}

export type OpenAiResponsesClient = {
  responses: {
    create: (
      params: {
        model: string
        service_tier?: 'default' | 'fast'
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
        reasoning: { effort: 'none' | 'minimal' | 'low' }
        store: false
        stream?: boolean
      },
      options?: { timeout?: number; signal?: AbortSignal },
    ) => Promise<unknown>
  }
}

type OpenAiResponseStream = AsyncIterable<unknown>

type LocalSolDispatchBinding = {
  callId: string
  sdkRequestSha256: string
  adapterInputsSha256: string
  reservedE8Usd: string
}
export type LocalSolEvaluationProfile = {
  profile: 'LOCAL_SOL_EVALUATION_V1'
  callId: string
  expectedSdkRequestSha256: string
  expectedAdapterInputsSha256: string
  admitReservedDispatch: (binding: LocalSolDispatchBinding) => Promise<
    LocalSolDispatchBinding & {
      reservationId: string
      attemptNumber: 1
      dispatchRecorded: true
    }
  >
  observeRawResponse: (
    observation: LocalSolDispatchBinding & {
      rawResponse: unknown
      rawResponseSha256: string
      sdkTransportMs: number
    },
  ) => Promise<{
    callId: string
    sdkRequestSha256: string
    rawResponseSha256: string
    persisted: true
  }>
}
/** A separately authorized real-corpus window; never a production route option. */
export type LocalCorpusEvaluationProfile = Omit<LocalSolEvaluationProfile, 'profile'> & {
  profile: 'LOCAL_CORPUS_EVALUATION_V1'
  modelKey: 'guest-chat-luna' | 'guest-chat-sol'
}
const localSolDispatchedCalls = new Set<string>()
const localSolResponseSchema = localPlannerUsageSchema.extend({
  model: z.literal('gpt-6.1-sol'),
  id: z.string().min(1).max(191),
  status: z.literal('completed'),
  service_tier: z.literal('default'),
  error: z.null().optional(),
  incomplete_details: z.null().optional(),
})
const localCorpusResponseSchema = localSolResponseSchema.extend({
  model: z.enum(['gpt-6-luna', 'gpt-6.1-sol']),
})
/** The corpus controller uses this same strict accounting check before releasing a reservation. */
export function validateLocalCorpusEvaluationResponse(
  raw: unknown,
  modelKey: LocalCorpusEvaluationProfile['modelKey'],
) {
  assertLocalSol(['guest-chat-luna', 'guest-chat-sol'].includes(modelKey))
  const spec = getAiModelSpec(modelKey)
  const checked = localCorpusResponseSchema.safeParse(raw)
  assertLocalSol(checked.success)
  assertLocalSol(checked.data.model === spec.model)
  const u = checked.data.usage,
    d = u.input_tokens_details
  assertLocalSol(
    u.input_tokens <= spec.maxBillableInputTokens &&
      u.output_tokens <= spec.maxOutputTokens &&
      u.total_tokens === u.input_tokens + u.output_tokens &&
      Number.isSafeInteger(u.total_tokens) &&
      d.cached_tokens + d.cache_write_tokens <= u.input_tokens &&
      (d.cache_write_tokens_details?.ttl_12h_tokens ?? 0) === 0 &&
      u.output_tokens_details.reasoning_tokens <= u.output_tokens,
  )
  return checked.data
}
const localSolHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const localSolInputs = (params: {
  spec: AiModelSpec
  system: AiSystemBlock[]
  messages: AiMessage[]
  maxOutputTokens: number
  timeoutMs: number
}) => ({
  spec: params.spec,
  system: params.system,
  messages: params.messages,
  maxOutputTokens: params.maxOutputTokens,
  timeoutMs: params.timeoutMs,
})

function assertLocalSol(condition: unknown): asserts condition {
  if (!condition) throw new Error('LOCAL_SOL_EVALUATION_CONTRACT_FAILED')
}

const openAiStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('response.output_text.delta'), delta: z.string() }).passthrough(),
  z.object({ type: z.literal('response.completed'), response: openAiResponseSchema }).passthrough(),
  z
    .object({ type: z.literal('response.incomplete'), response: openAiResponseSchema })
    .passthrough(),
  z.object({ type: z.literal('response.failed'), response: openAiResponseSchema }).passthrough(),
])

type OpenAiResponsesProviderId = Extract<AiTextProviderId, 'openai' | 'deepseek'>

// gpt-6.1-sol rejects minimal; low is its cheapest level and the one that was measured.
function reasoningEffort(model: string): 'none' | 'minimal' | 'low' {
  if (model === 'gpt-6-luna') return 'none'
  if (model === 'gpt-6.1-sol') return 'low'
  return 'minimal'
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
  invocationProfile?: LocalLunaPlannerProfile
  signal?: AbortSignal
  localSolEvaluation?: LocalSolEvaluationProfile
  localCorpusEvaluation?: LocalCorpusEvaluationProfile
}): Promise<{
  text: string
  usage: AiTokenUsage
  incomplete?: boolean
  serviceTier?: LocalLunaTierReceipt
}> {
  const submittedParams = params
  assertLocalSol(!(params.localSolEvaluation && params.localCorpusEvaluation))
  const corpus = params.localCorpusEvaluation
  const sol = params.localSolEvaluation ?? corpus
  const solAdmit = sol?.admitReservedDispatch
  const solObserve = sol?.observeRawResponse
  const solControl = sol
    ? {
        profile: sol.profile,
        callId: sol.callId,
        expectedSdkRequestSha256: sol.expectedSdkRequestSha256,
        expectedAdapterInputsSha256: sol.expectedAdapterInputsSha256,
        ...(corpus ? { modelKey: corpus.modelKey } : {}),
      }
    : undefined
  if (sol) {
    assertLocalSol(process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
    assertLocalSol(
      (corpus
        ? corpus.profile === 'LOCAL_CORPUS_EVALUATION_V1' &&
          ['guest-chat-luna', 'guest-chat-sol'].includes(corpus.modelKey)
        : sol.profile === 'LOCAL_SOL_EVALUATION_V1') &&
        typeof sol.callId === 'string' &&
        sol.callId.length > 0 &&
        sol.callId.length <= 200,
    )
    assertLocalSol(
      typeof sol.admitReservedDispatch === 'function' &&
        typeof sol.observeRawResponse === 'function',
    )
    assertLocalSol(!params.invocationProfile && !params.signal)
    if (corpus) {
      const expected = getAiModelSpec(corpus.modelKey)
      assertLocalSol(JSON.stringify(params.spec) === JSON.stringify(expected))
      assertLocalSol(params.spec.provider === 'openai' && params.spec.model === expected.model)
      assertLocalSol(
        params.timeoutMs === expected.timeoutMs &&
          params.maxOutputTokens === expected.maxOutputTokens,
      )
    } else {
      assertLocalSol(
        JSON.stringify(params.spec) === JSON.stringify(getAiModelSpec('guest-chat-sol')),
      )
      assertLocalSol(params.spec.provider === 'openai' && params.spec.model === 'gpt-6.1-sol')
      assertLocalSol(params.timeoutMs === 20_000 && [1024, 2048].includes(params.maxOutputTokens))
    }
    assertLocalSol(localSolHash(localSolInputs(params)) === sol.expectedAdapterInputsSha256)
    params = { ...params, ...structuredClone(localSolInputs(params)) }
  }
  const profile = params.invocationProfile
  if (profile !== undefined)
    assertLocalLunaPlannerProfile(profile, params.spec, {
      maxAttempts: 1,
      maxOutputTokens: params.maxOutputTokens,
      streaming: false,
      explicitCache: params.system.some((block) => block.cache_control?.type === 'ephemeral'),
    })
  const prompt = promptInput(
    params.spec.provider,
    params.spec.model,
    params.system,
    params.messages,
  )
  const request = {
    model: params.spec.model,
    ...prompt,
    max_output_tokens: params.maxOutputTokens,
    reasoning: { effort: params.spec.reasoningEffort ?? reasoningEffort(params.spec.model) },
    store: false as const,
    ...(profile
      ? {
          service_tier: profile === 'LOCAL_LUNA_FAST_V1' ? ('fast' as const) : ('default' as const),
        }
      : {}),
    ...(sol ? { service_tier: 'default' as const } : {}),
  }
  const requestBytes = profile ? Buffer.from(JSON.stringify(request), 'utf8') : undefined
  let solBinding: LocalSolDispatchBinding | undefined
  if (sol) {
    assertLocalSol(
      Buffer.byteLength(JSON.stringify(request), 'utf8') <= params.spec.maxInputUtf8Bytes,
    )
    assertLocalSol(localSolHash(request) === solControl!.expectedSdkRequestSha256)
    const reservedE8Usd = textAttemptCostCeilingUnits({
      spec: params.spec,
      system: params.system,
      messages: params.messages,
      maxOutputTokens: params.maxOutputTokens,
    }).toString()
    solBinding = {
      callId: solControl!.callId,
      sdkRequestSha256: localSolHash(request),
      adapterInputsSha256: localSolHash(localSolInputs(params)),
      reservedE8Usd,
    }
    const receipt = await solAdmit!({ ...solBinding })
    assertLocalSol(
      receipt &&
        receipt.callId === solBinding.callId &&
        receipt.sdkRequestSha256 === solBinding.sdkRequestSha256 &&
        receipt.adapterInputsSha256 === solBinding.adapterInputsSha256 &&
        receipt.reservedE8Usd === reservedE8Usd &&
        typeof receipt.reservationId === 'string' &&
        receipt.reservationId.length > 0 &&
        receipt.attemptNumber === 1 &&
        receipt.dispatchRecorded === true,
    )
    assertLocalSol(localSolHash(localSolInputs(submittedParams)) === solBinding.adapterInputsSha256)
    assertLocalSol(sol.admitReservedDispatch === solAdmit && sol.observeRawResponse === solObserve)
    assertLocalSol(localSolHash(request) === solBinding.sdkRequestSha256)
    assertLocalSol(
      localSolHash({
        profile: sol.profile,
        callId: sol.callId,
        expectedSdkRequestSha256: sol.expectedSdkRequestSha256,
        expectedAdapterInputsSha256: sol.expectedAdapterInputsSha256,
        ...(corpus ? { modelKey: corpus.modelKey } : {}),
      }) === localSolHash(solControl),
    )
    assertLocalSol(!localSolDispatchedCalls.has(solBinding.callId))
    localSolDispatchedCalls.add(solBinding.callId)
  }
  const solStarted = sol ? performance.now() : 0
  const raw = await getOpenAiResponsesClient(params.spec.provider).responses.create(request, {
    timeout: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
  })
  if (sol && solBinding) {
    const rawResponseSha256 = localSolHash(raw)
    const receipt = await solObserve!({
      ...solBinding,
      rawResponse: structuredClone(raw),
      rawResponseSha256,
      sdkTransportMs: performance.now() - solStarted,
    })
    assertLocalSol(
      receipt &&
        receipt.persisted === true &&
        receipt.callId === solBinding.callId &&
        receipt.sdkRequestSha256 === solBinding.sdkRequestSha256 &&
        receipt.rawResponseSha256 === rawResponseSha256,
    )
    assertLocalSol(localSolHash(raw) === rawResponseSha256)
    if (corpus) {
      validateLocalCorpusEvaluationResponse(raw, corpus.modelKey)
    } else {
      const checked = localSolResponseSchema.safeParse(raw)
      assertLocalSol(checked.success)
      const u = checked.data.usage,
        d = u.input_tokens_details
      assertLocalSol(
        u.input_tokens <= params.spec.maxBillableInputTokens &&
          u.output_tokens <= params.maxOutputTokens &&
          u.total_tokens === u.input_tokens + u.output_tokens &&
          Number.isSafeInteger(u.total_tokens) &&
          d.cached_tokens + d.cache_write_tokens <= u.input_tokens &&
          (d.cache_write_tokens_details?.ttl_12h_tokens ?? 0) === 0 &&
          u.output_tokens_details.reasoning_tokens <= u.output_tokens,
      )
    }
  }
  if (profile)
    validateLocalPlannerUsage(raw, params.maxOutputTokens, params.spec.maxBillableInputTokens)
  let response: z.infer<typeof openAiResponseSchema>
  try {
    response = openAiResponseSchema.parse(raw)
  } catch (error) {
    if (profile) throw new LocalLunaPlannerExecutionError('INVALID_PLANNER_USAGE')
    throw error
  }
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
  if (params.localSolEvaluation) assertLocalSol(!incomplete && text.length > 0)
  const tier =
    typeof response.service_tier === 'string' && response.service_tier.length <= 64
      ? response.service_tier
      : null
  const multiplier =
    tier === 'default' ? (1 as const) : tier === 'fast' || tier === 'priority' ? (2 as const) : null
  const serviceTier: LocalLunaTierReceipt | undefined = profile
    ? {
        profile,
        requestedTier: profile === 'LOCAL_LUNA_FAST_V1' ? 'fast' : 'default',
        observedTier: tier,
        providerResponseId:
          typeof response.id === 'string' && response.id.length > 0 && response.id.length <= 191
            ? response.id
            : null,
        sdkRequestSha256: createHash('sha256').update(requestBytes!).digest('hex'),
        sdkRequestUtf8Bytes: requestBytes!.length,
        wireBoundary: 'SDK_PARAMS_JSON_NOT_OBSERVED_HTTP',
        costObservationStatus: multiplier === null ? 'UNKNOWN' : 'OBSERVED',
        rateMultiplier: multiplier,
        outcome:
          multiplier === null
            ? 'UNKNOWN_TIER'
            : multiplier === 1
              ? profile === 'LOCAL_LUNA_FAST_V1'
                ? 'STANDARD_DOWNGRADE'
                : 'STANDARD_SERVED'
              : profile === 'LOCAL_LUNA_STANDARD_V1'
                ? 'UNEXPECTED_FAST_TIER'
                : 'FAST_SERVED',
      }
    : undefined
  return {
    ...(serviceTier ? { serviceTier } : {}),
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
  invocationProfile?: LocalLunaPlannerProfile
  signal?: AbortSignal
}): Promise<{ text: string; usage: AiTokenUsage; incomplete?: boolean }> {
  if (params.invocationProfile !== undefined)
    assertLocalLunaPlannerProfile(params.invocationProfile, params.spec, {
      maxAttempts: 1,
      maxOutputTokens: params.maxOutputTokens,
      streaming: true,
    })
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
      reasoning: { effort: params.spec.reasoningEffort ?? reasoningEffort(params.spec.model) },
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
