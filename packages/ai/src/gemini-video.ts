import type { AiTokenUsage, AiUsageRecord, AiUsageSink } from './anthropic'
import {
  createAiInvocationId,
  observedAiCostUnits,
  type AiBudgetGate,
  type AiBudgetReservationRef,
} from './budget'

export const GEMINI_VIDEO_MODEL = 'gemini-3.7-flash' as const
export const GEMINI_VIDEO_PRICING_VERSION = 'google-gemini-public-2026-09-01' as const
export const GEMINI_VIDEO_MAX_INPUT_TOKENS = 1_048_576
export const GEMINI_VIDEO_MAX_OUTPUT_TOKENS = 8_192
export const GEMINI_VIDEO_PROCESSING_TIMEOUT_MS = 15 * 60 * 1_000
export const GEMINI_VIDEO_DELETE_TIMEOUT_MS = 30_000

export class GeminiVideoDeletionUnconfirmedError extends Error {
  readonly code = 'provider-file-delete-unconfirmed'

  constructor() {
    super('Gemini video file deletion could not be confirmed')
    this.name = 'GeminiVideoDeletionUnconfirmedError'
  }
}

// Fixed 1e-8 USD units. The reservation uses the documented post-introductory
// rates ($1.50 input / $7.50 output per million) so the gate remains
// conservative after the 2026 introductory period ends.
export const GEMINI_VIDEO_ATTEMPT_CEILING_UNITS =
  BigInt(GEMINI_VIDEO_MAX_INPUT_TOKENS) * 150n + BigInt(GEMINI_VIDEO_MAX_OUTPUT_TOKENS) * 750n

const INTRODUCTORY_INPUT_USD_PER_MILLION = 0.75
const INTRODUCTORY_CACHED_INPUT_USD_PER_MILLION = 0.075
const INTRODUCTORY_OUTPUT_USD_PER_MILLION = 3.75

type GeminiFile = {
  name?: string
  uri?: string
  mimeType?: string
  state?: 'STATE_UNSPECIFIED' | 'PROCESSING' | 'ACTIVE' | 'FAILED'
}

type GeminiGenerateContentResponse = {
  text?: string
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
  }
}

export type GeminiVideoClient = {
  files: {
    upload(params: {
      file: string
      config: { name: string; mimeType: string; displayName: string; abortSignal: AbortSignal }
    }): Promise<GeminiFile>
    get(params: { name: string; config: { abortSignal: AbortSignal } }): Promise<GeminiFile>
    delete(params: { name: string; config: { abortSignal: AbortSignal } }): Promise<unknown>
  }
  models: {
    generateContent(params: {
      model: string
      contents: Array<{ fileData: { fileUri: string; mimeType: string } } | { text: string }>
      config: {
        abortSignal: AbortSignal
        maxOutputTokens: number
        responseMimeType: 'application/json'
        responseJsonSchema?: unknown
        thinkingConfig: { thinkingLevel: 'low' }
      }
    }): Promise<GeminiGenerateContentResponse>
  }
}

let geminiVideoClient: GeminiVideoClient | null = null

export function resolveGeminiVideoModel(value?: string): typeof GEMINI_VIDEO_MODEL {
  if (!value) return GEMINI_VIDEO_MODEL
  if (value !== GEMINI_VIDEO_MODEL) {
    throw new Error('MEDIA_VIDEO_ANALYSIS_MODEL must use the reviewed model')
  }
  return value
}

export function setGeminiVideoClientForTesting(client: GeminiVideoClient | null): void {
  geminiVideoClient = client
}

async function getGeminiVideoClient(): Promise<GeminiVideoClient> {
  if (!geminiVideoClient) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured')
    const { GoogleGenAI } = await import('@google/genai')
    geminiVideoClient = new GoogleGenAI({
      apiKey,
      // Provider retries would spend outside the single attempt reserved below.
      httpOptions: { retryOptions: { attempts: 1 } },
    }) as unknown as GeminiVideoClient
  }
  return geminiVideoClient
}

function emptyUsage(): AiTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }
}

function usageFromResponse(response: GeminiGenerateContentResponse): AiTokenUsage {
  const metadata = response.usageMetadata
  const prompt = metadata?.promptTokenCount
  const output = metadata?.candidatesTokenCount
  const cached = metadata?.cachedContentTokenCount ?? 0
  if (
    !Number.isSafeInteger(prompt) ||
    !Number.isSafeInteger(output) ||
    !Number.isSafeInteger(cached) ||
    prompt! < 0 ||
    output! < 0 ||
    cached < 0 ||
    cached > prompt! ||
    prompt! > GEMINI_VIDEO_MAX_INPUT_TOKENS ||
    output! > GEMINI_VIDEO_MAX_OUTPUT_TOKENS
  ) {
    throw new Error('Gemini video response returned invalid usage metadata')
  }
  return {
    inputTokens: prompt! - cached,
    outputTokens: output!,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cached,
  }
}

function estimatedCostUsd(usage: AiTokenUsage): number {
  return (
    (usage.inputTokens * INTRODUCTORY_INPUT_USD_PER_MILLION +
      usage.cacheReadInputTokens * INTRODUCTORY_CACHED_INPUT_USD_PER_MILLION +
      usage.outputTokens * INTRODUCTORY_OUTPUT_USD_PER_MILLION) /
    1_000_000
  )
}

function errorCode(error: unknown, outputObserved: boolean): string {
  if (outputObserved) return 'invalid-structured-output'
  if (error && typeof error === 'object') {
    const status = 'status' in error ? (error as { status?: unknown }).status : undefined
    const name = 'name' in error ? (error as { name?: unknown }).name : undefined
    if (typeof status === 'number') return `provider-http-${status}`
    if (name === 'AbortError' || name === 'TimeoutError') return String(name)
  }
  return 'provider-error'
}

async function recordUsage(sink: AiUsageSink, record: AiUsageRecord): Promise<void> {
  try {
    await sink(record)
  } catch {
    // Usage persistence must never alter media processing behavior.
  }
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, 2_000)
    function done() {
      signal.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timeout)
      signal.removeEventListener('abort', aborted)
      reject(new DOMException('Gemini video processing was cancelled.', 'AbortError'))
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

async function waitForActiveFile(
  client: GeminiVideoClient,
  file: GeminiFile,
  signal: AbortSignal,
): Promise<GeminiFile> {
  let current = file
  while (current.state === 'PROCESSING' || current.state === 'STATE_UNSPECIFIED') {
    await waitForPoll(signal)
    if (!current.name) throw new Error('Gemini video upload returned no file name')
    current = await client.files.get({ name: current.name, config: { abortSignal: signal } })
  }
  if (current.state !== 'ACTIVE') throw new Error('Gemini video processing failed')
  if (!current.name || !current.uri || !current.mimeType) {
    throw new Error('Gemini video upload returned incomplete file identity')
  }
  return current
}

export async function analyzeGeminiVideo<TParsed>(params: {
  filePath: string
  filename: string
  mimeType: string
  model: typeof GEMINI_VIDEO_MODEL
  prompt: string
  responseJsonSchema?: unknown
  parseResponse: (text: string) => TParsed
  usageSink: AiUsageSink
  budgetGate: AiBudgetGate
  invocationId?: string
  signal?: AbortSignal
}): Promise<TParsed> {
  const startedAt = performance.now()
  const invocationId = params.invocationId ?? createAiInvocationId()
  const providerFileId = createAiInvocationId()
  const deadline = AbortSignal.timeout(GEMINI_VIDEO_PROCESSING_TIMEOUT_MS)
  const signal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline
  let usage = emptyUsage()
  let reservation: AiBudgetReservationRef | null = null
  let dispatched = false
  let usageObserved = false
  let outputObserved = false
  let uploadedName: string | null = null
  let outcome: { ok: true; value: TParsed } | { ok: false; error: unknown }

  try {
    reservation = await params.budgetGate.reserve({
      invocationId,
      attemptNumber: 1,
      provider: 'google',
      model: params.model,
      pricingVersion: GEMINI_VIDEO_PRICING_VERSION,
      reservedUnits: GEMINI_VIDEO_ATTEMPT_CEILING_UNITS,
    })
    let client: GeminiVideoClient
    try {
      client = await getGeminiVideoClient()
    } catch (error) {
      if (reservation)
        await params.budgetGate.releaseUndispatched(reservation).catch(() => undefined)
      reservation = null
      throw error
    }

    if (reservation) {
      try {
        // Uploading client media crosses the provider boundary, so mark the
        // reservation before the first byte is dispatched rather than waiting
        // for model generation.
        await params.budgetGate.markDispatched(reservation)
      } catch (error) {
        await params.budgetGate.releaseUndispatched(reservation).catch(() => undefined)
        reservation = null
        throw error
      }
    }
    dispatched = true
    // Preselect the provider resource name before upload. Even if the client
    // loses the upload response after the service accepts bytes, cleanup still
    // has an exact identity to delete and cannot silently abandon client media.
    uploadedName = `files/torchiko-${providerFileId}`
    const uploaded = await client.files.upload({
      file: params.filePath,
      config: {
        name: uploadedName,
        mimeType: params.mimeType,
        displayName: params.filename.slice(0, 512),
        abortSignal: signal,
      },
    })
    // Treat an empty or whitespace-only SDK response name like an omitted
    // name. The preselected identity is still the only safe cleanup target.
    uploadedName = uploaded.name?.trim() || uploadedName
    const active = await waitForActiveFile(client, uploaded, signal)

    const response = await client.models.generateContent({
      model: params.model,
      contents: [
        { fileData: { fileUri: active.uri!, mimeType: active.mimeType! } },
        { text: params.prompt },
      ],
      config: {
        abortSignal: signal,
        maxOutputTokens: GEMINI_VIDEO_MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        ...(params.responseJsonSchema ? { responseJsonSchema: params.responseJsonSchema } : {}),
        thinkingConfig: { thinkingLevel: 'low' },
      },
    })
    usage = usageFromResponse(response)
    usageObserved = Boolean(response.usageMetadata)
    if (reservation && usageObserved) {
      await params.budgetGate
        .settleExact(reservation, observedAiCostUnits(estimatedCostUsd(usage)))
        .catch(() => undefined)
      reservation = null
    }
    const text = response.text
    if (!text) throw new Error('Gemini video response was empty')
    outputObserved = true
    outcome = { ok: true, value: params.parseResponse(text) }
  } catch (error) {
    outcome = { ok: false, error }
  }

  let cleanupError: unknown
  if (uploadedName) {
    try {
      const cleanupSignal = AbortSignal.timeout(GEMINI_VIDEO_DELETE_TIMEOUT_MS)
      const cleanupClient = await getGeminiVideoClient()
      await cleanupClient.files.delete({
        name: uploadedName,
        config: { abortSignal: cleanupSignal },
      })
    } catch (error) {
      cleanupError = error
    }
  }

  if (reservation && dispatched && !usageObserved) {
    await params.budgetGate.settleAmbiguous(reservation).catch(() => undefined)
    reservation = null
  } else if (reservation && !dispatched) {
    await params.budgetGate.releaseUndispatched(reservation).catch(() => undefined)
    reservation = null
  }

  const success = outcome.ok && cleanupError === undefined
  const outcomeError = outcome.ok ? undefined : outcome.error
  await recordUsage(params.usageSink, {
    provider: 'google',
    model: params.model,
    pricingVersion: GEMINI_VIDEO_PRICING_VERSION,
    usage,
    estimatedCostUsd: estimatedCostUsd(usage),
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    attempts: dispatched ? 1 : 0,
    success,
    ...(!success
      ? {
          errorCode:
            cleanupError !== undefined
              ? 'provider-file-delete-unconfirmed'
              : errorCode(outcomeError, outputObserved),
        }
      : {}),
    capability: 'MEDIA_VIDEO_UNDERSTANDING',
  })

  if (cleanupError !== undefined) {
    throw new GeminiVideoDeletionUnconfirmedError()
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}
