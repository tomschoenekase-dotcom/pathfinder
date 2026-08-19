import {
  ClientTochiContextSchema,
  ClientTochiResponseSchema,
  type ClientTochiContext,
  type ClientTochiResponse,
} from '@pathfinder/ai'
import { z } from 'zod'

export const CLIENT_TOCHI_MAX_QUESTION_LENGTH = 2_000
export const CLIENT_TOCHI_MAX_HISTORY_TURNS = 8
export const CLIENT_TOCHI_MAX_TURN_LENGTH = 1_200

const questionSchema = z
  .string()
  .trim()
  .min(1)
  .max(CLIENT_TOCHI_MAX_QUESTION_LENGTH)
  .refine((value) => !value.includes('\0'), 'Message contains an unsupported character')

const recentUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
})

export type ClientAssistantContextSource = {
  venue: {
    id: string
    name: string
    tonePreset?: string | null
    presentationMode?: string | null
  }
  lifecycle: {
    stage?: string | null
    summary: string
    currentAction?: string | null
  }
  uploads?: {
    total: number
    recent: Array<{ fileName: string }>
  }
  pendingQuestionCount?: number
}

const supportedStages = new Set<ClientTochiContext['onboardingStage']>([
  'WELCOME',
  'SHARE',
  'PROCESSING',
  'QUESTIONS',
  'READY',
  'LIVE',
  'PAUSED',
])

const supportedPresets = new Set<ClientTochiContext['tonePreset']>([
  'friendly',
  'concise',
  'enthusiastic',
  'informative',
])

export function parseClientTochiQuestion(question: string): string {
  return questionSchema.parse(question)
}

export function buildClientAssistantContext(
  source: ClientAssistantContextSource,
): ClientTochiContext {
  const recent = (source.uploads?.recent ?? [])
    .slice(0, 10)
    .map((upload) => recentUploadSchema.parse(upload).fileName)
  const stage = source.lifecycle.stage
  const tonePreset = source.venue.tonePreset
  const presentationMode = source.venue.presentationMode

  return ClientTochiContextSchema.parse({
    venueId: source.venue.id,
    venueName: source.venue.name,
    ...(stage && supportedStages.has(stage as ClientTochiContext['onboardingStage'])
      ? { onboardingStage: stage }
      : {}),
    lifecycleSummary: source.lifecycle.summary,
    ...(source.lifecycle.currentAction ? { currentAction: source.lifecycle.currentAction } : {}),
    ...(source.uploads
      ? {
          uploadedMaterials: {
            total: Math.max(0, Math.floor(source.uploads.total)),
            recentFilenames: recent,
          },
        }
      : {}),
    ...(source.pendingQuestionCount !== undefined
      ? { pendingQuestionCount: Math.max(0, Math.floor(source.pendingQuestionCount)) }
      : {}),
    ...(tonePreset && supportedPresets.has(tonePreset as ClientTochiContext['tonePreset'])
      ? { tonePreset }
      : {}),
    ...(presentationMode === 'CLASSIC' || presentationMode === 'CHARACTER'
      ? { presentationMode }
      : {}),
    allowedRoutes: {
      home: '/',
      information: '/information',
      help: '/support',
      venueBotSettings: '/ai-controls',
    },
  })
}

export type ClientAssistantClientReply = {
  answer: string
  category: ClientTochiResponse['category']
  action?:
    | { type: 'navigate'; href: string; label: string }
    | {
        type: 'preview-support-handoff'
        category:
          | 'CONTENT_CORRECTION'
          | 'OPERATIONAL_UPDATE'
          | 'BRANDING'
          | 'EXPERIENCE_BEHAVIOR'
          | 'ACCESSIBILITY'
          | 'GENERAL'
        summary: string
        requestedOutcome: string
        relevantFeature?: string
      }
}

export function projectClientTochiResponse(
  rawResponse: ClientTochiResponse,
  rawContext: ClientTochiContext,
): ClientAssistantClientReply {
  const response = ClientTochiResponseSchema.parse(rawResponse)
  const context = ClientTochiContextSchema.parse(rawContext)
  if (!response.action) {
    return { answer: response.answer, category: response.category }
  }

  if (response.action.type === 'navigate') {
    return {
      answer: response.answer,
      category: response.category,
      action: {
        type: 'navigate',
        href: context.allowedRoutes[response.action.routeKey],
        label: response.action.label,
      },
    }
  }

  return {
    answer: response.answer,
    category: response.category,
    action: {
      type: 'preview-support-handoff',
      category: response.action.category,
      summary: response.action.summary,
      requestedOutcome: response.action.requestedOutcome,
      ...(response.action.relevantFeature
        ? { relevantFeature: response.action.relevantFeature }
        : {}),
    },
  }
}

export function safeClientTochiFailureReply(): ClientAssistantClientReply {
  return {
    answer:
      'I could not check that right now. Your portal still works normally, and Help & changes is available if you need the Torchiko team.',
    category: 'general-help',
    action: { type: 'navigate', href: '/support', label: 'Open Help & changes' },
  }
}

export function boundedClientAssistantHistory(
  turns: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return turns
    .slice(-CLIENT_TOCHI_MAX_HISTORY_TURNS)
    .map((turn) => ({
      ...turn,
      content: turn.content.trim().slice(0, CLIENT_TOCHI_MAX_TURN_LENGTH),
    }))
    .filter((turn) => turn.content.length > 0)
}

export function safeHandoffExcerpt(
  turns: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return boundedClientAssistantHistory(turns)
    .slice(-4)
    .map((turn) => ({ ...turn, content: turn.content.slice(0, 300) }))
}
