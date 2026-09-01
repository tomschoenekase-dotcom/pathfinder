import OpenAI from 'openai'
import { z } from 'zod'

const chatCompletionSchema = z.object({
  choices: z.array(
    z
      .object({
        message: z.object({ content: z.string().nullable().optional() }).passthrough(),
      })
      .passthrough(),
  ),
})

const transcriptionSchema = z.object({ text: z.string() })

export const OPENAI_MEDIA_JSON_MODEL = 'gpt-5.6-luna' as const
export const OPENAI_MEDIA_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe' as const

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

export async function createOpenAiMediaJson(params: {
  model: typeof OPENAI_MEDIA_JSON_MODEL
  messages: OpenAiMediaMessage[]
  signal?: AbortSignal
}): Promise<string> {
  const raw = await getOpenAiMediaClient().chat.completions.create(
    {
      model: params.model,
      response_format: { type: 'json_object' },
      messages: params.messages,
    },
    params.signal ? { signal: params.signal } : undefined,
  )
  const response = chatCompletionSchema.parse(raw)
  const text = response.choices[0]?.message.content
  if (!text) throw new Error('OpenAI media JSON response was empty')
  return text
}

export async function transcribeOpenAiMedia(params: {
  file: unknown
  model: typeof OPENAI_MEDIA_TRANSCRIPTION_MODEL
  signal?: AbortSignal
}): Promise<string> {
  const raw = await getOpenAiMediaClient().audio.transcriptions.create(
    { file: params.file, model: params.model },
    params.signal ? { signal: params.signal } : undefined,
  )
  return transcriptionSchema.parse(raw).text
}
