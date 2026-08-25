import { z } from 'zod'

export const SUPPORTED_CHAT_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'ar', label: 'العربية' },
] as const

const supportedChatLanguageLabels = [
  'English',
  'Español',
  'Français',
  'Deutsch',
  'Italiano',
  'Português',
  '中文',
  '日本語',
  '한국어',
  'العربية',
] as const

export const SupportedChatLanguageInput = z.enum(supportedChatLanguageLabels)
export type SupportedChatLanguage = z.infer<typeof SupportedChatLanguageInput>

const guestCoordinatesShape = {
  lat: z.number().finite().min(-90).max(90).optional(),
  lng: z.number().finite().min(-180).max(180).optional(),
} as const

function validateGuestCoordinates(
  value: { lat?: number | undefined; lng?: number | undefined },
  ctx: z.RefinementCtx,
): void {
  const hasLat = value.lat !== undefined
  const hasLng = value.lng !== undefined

  if (hasLat !== hasLng) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Latitude and longitude must be provided together.',
      path: hasLat ? ['lng'] : ['lat'],
    })
  }
}

export const ChatSessionInput = z
  .object({
    venueId: z.string().min(1).max(200),
    anonymousToken: z.string().uuid(),
    visitorId: z.string().uuid().optional(),
    secondLayerKey: z.string().uuid().optional(),
    ...guestCoordinatesShape,
  })
  .strict()
  .superRefine(validateGuestCoordinates)

export const ChatSendInput = z
  .object({
    operationId: z.string().uuid().optional(),
    venueId: z.string().min(1).max(200),
    anonymousToken: z.string().uuid(),
    visitorId: z.string().uuid().optional(),
    secondLayerKey: z.string().uuid().optional(),
    message: z.string().trim().min(1).max(1000),
    responseIntent: z.enum(['DEFAULT', 'EXPAND']).optional(),
    ...guestCoordinatesShape,
    language: SupportedChatLanguageInput.optional(),
  })
  .strict()
  .superRefine(validateGuestCoordinates)

export const ChatHistoryInput = z
  .object({
    venueId: z.string().min(1).max(200),
    anonymousToken: z.string().uuid(),
    secondLayerKey: z.string().uuid().optional(),
  })
  .strict()
