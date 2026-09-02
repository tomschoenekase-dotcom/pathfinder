import { z } from 'zod'

export const RealtimeVoiceTier = z.enum(['ECONOMY', 'PREMIUM'])
export type RealtimeVoiceTier = z.infer<typeof RealtimeVoiceTier>

export type RealtimeVoiceRoute = {
  capability: 'REALTIME_VOICE' | 'REALTIME_VOICE_ECONOMY'
  tier: RealtimeVoiceTier
  provider: 'openai'
  model: string
  transcriptionModel: string
}

const safeModelName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/u)

export function resolveRealtimeVoiceRoute(params: {
  tier: RealtimeVoiceTier
  premiumEntitled?: boolean
  providerAvailable?: boolean
  environment?: Readonly<Record<string, string | undefined>>
}): RealtimeVoiceRoute {
  const tier = RealtimeVoiceTier.parse(params.tier)
  if (params.providerAvailable === false) throw new Error('Realtime voice provider is unavailable')
  if (tier === 'PREMIUM' && params.premiumEntitled !== true) {
    throw new Error('Premium realtime voice is not entitled')
  }
  const environment = params.environment ?? process.env
  const model = safeModelName.parse(
    tier === 'PREMIUM'
      ? (environment.OPENAI_REALTIME_PREMIUM_MODEL ?? 'gpt-realtime-2.1')
      : (environment.OPENAI_REALTIME_ECONOMY_MODEL ?? 'gpt-realtime-2.1-mini'),
  )
  return {
    capability: tier === 'PREMIUM' ? 'REALTIME_VOICE' : 'REALTIME_VOICE_ECONOMY',
    tier,
    provider: 'openai',
    model,
    transcriptionModel: safeModelName.parse(
      environment.OPENAI_REALTIME_TRANSCRIPTION_MODEL ?? 'gpt-live-transcribe',
    ),
  }
}

export type RealtimeVoiceUsage = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cachedAudioInputTokens: number
  audioInputTokens: number
  audioOutputTokens: number
}

const REALTIME_PRICING_USD_PER_MILLION = {
  'gpt-realtime-2.1': {
    input: 4,
    cachedInput: 0.4,
    cachedAudioInput: 0.4,
    output: 24,
    audioInput: 32,
    audioOutput: 64,
  },
  'gpt-realtime-2.1-mini': {
    input: 0.6,
    cachedInput: 0.06,
    cachedAudioInput: 0.3,
    output: 2.4,
    audioInput: 10,
    audioOutput: 20,
  },
} as const

export const REALTIME_VOICE_PRICING_VERSION = 'openai-model-pages-2026-08-19'

export function estimateRealtimeVoiceCostUsd(
  model: string,
  usage: RealtimeVoiceUsage,
): number | null {
  const pricing =
    REALTIME_PRICING_USD_PER_MILLION[model as keyof typeof REALTIME_PRICING_USD_PER_MILLION]
  if (!pricing) return null
  const nonnegative = Object.values(usage).every((value) => Number.isInteger(value) && value >= 0)
  if (!nonnegative) throw new Error('Realtime usage values must be nonnegative integers')
  const cachedTextInput = Math.max(0, usage.cachedInputTokens - usage.cachedAudioInputTokens)
  const uncachedTextInput = Math.max(
    0,
    usage.inputTokens - usage.audioInputTokens - cachedTextInput,
  )
  const uncachedAudioInput = Math.max(0, usage.audioInputTokens - usage.cachedAudioInputTokens)
  const textOutput = Math.max(0, usage.outputTokens - usage.audioOutputTokens)
  return (
    (uncachedTextInput * pricing.input +
      cachedTextInput * pricing.cachedInput +
      usage.cachedAudioInputTokens * pricing.cachedAudioInput +
      textOutput * pricing.output +
      uncachedAudioInput * pricing.audioInput +
      usage.audioOutputTokens * pricing.audioOutput) /
    1_000_000
  )
}

export type RealtimeVoiceAuthorization = {
  provider: 'openai'
  model: string
  clientSecret: string
  expiresAt: number
  providerSessionId: string | null
}

export interface RealtimeVoiceProviderAdapter {
  readonly provider: RealtimeVoiceAuthorization['provider']
  authorizeSession(input: {
    route: RealtimeVoiceRoute
    apiKey: string
    safetyIdentifier: string
    instructions: string
    voice: string
    language?: string
    fetchImpl?: typeof fetch
    requestTimeoutMs?: number
  }): Promise<RealtimeVoiceAuthorization>
}

const clientSecretResponse = z
  .object({
    value: z.string().min(1),
    expires_at: z.number().int().positive(),
    session: z
      .object({ id: z.string().min(1).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()

const voiceName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._-]+$/u)
const safetyId = z.string().regex(/^[a-f0-9]{64}$/u)
const REALTIME_AUTH_RESPONSE_MAX_BYTES = 1024 * 1024
const REALTIME_AUTH_TIMEOUT_MS = 30_000

function authorizationTimeout(value: number | undefined) {
  const timeoutMs = value ?? REALTIME_AUTH_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Realtime voice authorization timeout must be from 1 to 60000 milliseconds')
  }
  return timeoutMs
}

async function readAuthorizationJson(response: Response, signal: AbortSignal) {
  const declared = response.headers.get('content-length')
  if (
    declared &&
    (!/^\d+$/u.test(declared) || Number(declared) > REALTIME_AUTH_RESPONSE_MAX_BYTES)
  ) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error('invalid-response')
  }
  if (!response.body) throw new Error('invalid-response')

  const reader = response.body.getReader()
  const cancelOnAbort = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', cancelOnAbort, { once: true })
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let reading = true
  try {
    while (reading) {
      const { done, value } = await reader.read()
      if (done) {
        reading = false
        continue
      }
      totalBytes += value.byteLength
      if (totalBytes > REALTIME_AUTH_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined)
        throw new Error('invalid-response')
      }
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', cancelOnAbort)
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

export const openAiRealtimeVoiceAdapter: RealtimeVoiceProviderAdapter = {
  provider: 'openai',
  async authorizeSession(input) {
    const apiKey = z.string().min(1).parse(input.apiKey)
    const fetchImpl = input.fetchImpl ?? fetch
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      authorizationTimeout(input.requestTimeoutMs),
    )
    try {
      let response: Response
      try {
        response = await fetchImpl('https://api.openai.com/v1/realtime/client_secrets', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'OpenAI-Safety-Identifier': safetyId.parse(input.safetyIdentifier),
          },
          body: JSON.stringify({
            session: {
              type: 'realtime',
              model: input.route.model,
              instructions: z.string().trim().min(1).max(32_000).parse(input.instructions),
              audio: {
                input: {
                  transcription: {
                    model: input.route.transcriptionModel,
                    ...(input.language ? { language: input.language } : {}),
                  },
                },
                output: { voice: voiceName.parse(input.voice) },
              },
            },
          }),
          signal: controller.signal,
        })
      } catch {
        throw new Error(
          controller.signal.aborted
            ? 'Realtime voice authorization timed out'
            : 'Realtime voice authorization transport failed',
        )
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        throw new Error(`Realtime voice authorization failed (${response.status})`)
      }
      let parsed: z.infer<typeof clientSecretResponse>
      try {
        parsed = clientSecretResponse.parse(
          await readAuthorizationJson(response, controller.signal),
        )
      } catch {
        throw new Error(
          controller.signal.aborted
            ? 'Realtime voice authorization timed out'
            : 'Realtime voice authorization returned an invalid response',
        )
      }
      return {
        provider: 'openai',
        model: input.route.model,
        clientSecret: parsed.value,
        expiresAt: parsed.expires_at,
        providerSessionId: parsed.session?.id ?? null,
      }
    } finally {
      clearTimeout(timeout)
    }
  },
}
