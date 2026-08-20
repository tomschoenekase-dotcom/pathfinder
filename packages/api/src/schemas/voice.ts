import { RealtimeVoiceTier } from '@pathfinder/ai'
import { z } from 'zod'

const VoiceSessionIdentity = z
  .object({
    venueId: z.string().min(1).max(200),
    anonymousToken: z.string().uuid(),
    voiceSessionId: z.string().uuid(),
  })
  .strict()

export const VoiceAvailabilityInput = z
  .object({
    venueId: z.string().min(1).max(200),
    anonymousToken: z.string().uuid(),
  })
  .strict()

export const VoiceSessionStartInput = z
  .object({
    venueId: z.string().min(1).max(200),
    anonymousToken: z.string().uuid(),
    locale: z
      .string()
      .trim()
      .min(2)
      .max(35)
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u),
    tier: RealtimeVoiceTier.default('ECONOMY'),
  })
  .strict()

export const VoiceSessionConnectedInput = VoiceSessionIdentity

export const VoiceTranscriptSegmentInput = VoiceSessionIdentity.extend({
  providerEventId: z.string().trim().min(1).max(191),
  sequence: z.number().int().min(0).max(100_000),
  speaker: z.enum(['VISITOR', 'ASSISTANT']),
  text: z.string().trim().min(1).max(8_000),
  language: z.string().trim().min(2).max(35).optional(),
}).strict()

export const VoiceUsageInput = VoiceSessionIdentity.extend({
  providerEventId: z.string().trim().min(1).max(191),
  inputTokens: z.number().int().min(0).max(10_000_000),
  outputTokens: z.number().int().min(0).max(10_000_000),
  cachedInputTokens: z.number().int().min(0).max(10_000_000),
  cachedAudioInputTokens: z.number().int().min(0).max(10_000_000),
  audioInputTokens: z.number().int().min(0).max(10_000_000),
  audioOutputTokens: z.number().int().min(0).max(10_000_000),
})
  .strict()
  .superRefine((usage, ctx) => {
    if (
      usage.audioInputTokens > usage.inputTokens ||
      usage.audioOutputTokens > usage.outputTokens ||
      usage.cachedAudioInputTokens > usage.cachedInputTokens
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inputTokens'],
        message: 'Voice token details cannot exceed their totals',
      })
    }
  })

export const VoiceSessionEndInput = VoiceSessionIdentity.extend({
  fallbackToText: z.boolean().default(false),
  errorCode: z.string().trim().min(1).max(100).optional(),
}).strict()

export type VoiceSessionStartInput = z.infer<typeof VoiceSessionStartInput>
