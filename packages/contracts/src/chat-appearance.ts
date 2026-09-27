import { z } from 'zod'

/**
 * Venue-chosen visitor chat appearance layered on top of the chat theme preset.
 *
 * Every field is optional in storage: a missing or invalid value falls back to the
 * default below, so existing venues keep the plain (no background) presentation.
 * Colors are suggestions — the renderer corrects any pair that would be unreadable.
 */
const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/u)

export const ChatAppearanceBackgroundSchema = z
  .object({
    /** `image` uses the venue's reviewed banner derivative; there is no other image source. */
    mode: z.enum(['none', 'image']),
    /** Mobile crop focal point, in percent of the image. */
    focalX: z.number().int().min(0).max(100),
    focalY: z.number().int().min(0).max(100),
    /** Overlay strength in percent. Reading surfaces stay protected regardless. */
    dim: z.number().int().min(0).max(85),
  })
  .strict()

export const ChatAppearanceSchema = z
  .object({
    version: z.literal(1),
    userBubble: z.boolean(),
    assistantBubble: z.boolean(),
    userTextColor: HexColor.nullable(),
    assistantTextColor: HexColor.nullable(),
    userBubbleColor: HexColor.nullable(),
    assistantSurfaceColor: HexColor.nullable(),
    /** Visitor-facing title override. Null shows the venue name. */
    title: z.string().trim().min(1).max(80).nullable(),
    headerTitleColor: HexColor.nullable(),
    headerColor: HexColor.nullable(),
    /** Null keeps the bottom bar linked to the header color. */
    footerColor: HexColor.nullable(),
    background: ChatAppearanceBackgroundSchema,
    /** Shows the "Tell me more about that" follow-up action. */
    requestMore: z.boolean(),
  })
  .strict()

export type ChatAppearance = z.infer<typeof ChatAppearanceSchema>
export type ChatAppearanceBackground = z.infer<typeof ChatAppearanceBackgroundSchema>

export const DEFAULT_CHAT_APPEARANCE: ChatAppearance = Object.freeze({
  version: 1,
  userBubble: true,
  assistantBubble: false,
  userTextColor: null,
  assistantTextColor: null,
  userBubbleColor: null,
  assistantSurfaceColor: null,
  title: null,
  headerTitleColor: null,
  headerColor: null,
  footerColor: null,
  background: Object.freeze({ mode: 'none', focalX: 50, focalY: 50, dim: 45 }),
  requestMore: true,
}) as ChatAppearance

function pick<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : fallback
}

/**
 * Tolerant read of a stored or previewed appearance. Unknown keys are dropped and each
 * invalid field falls back independently, so one bad value never resets the whole theme.
 */
export function parseChatAppearance(value: unknown): ChatAppearance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_CHAT_APPEARANCE, background: { ...DEFAULT_CHAT_APPEARANCE.background } }
  }
  const input = value as Record<string, unknown>
  const shape = ChatAppearanceSchema.shape
  const backgroundInput =
    input.background && typeof input.background === 'object' && !Array.isArray(input.background)
      ? (input.background as Record<string, unknown>)
      : {}
  const backgroundShape = ChatAppearanceBackgroundSchema.shape
  const defaults = DEFAULT_CHAT_APPEARANCE
  return {
    version: 1,
    userBubble: pick(shape.userBubble, input.userBubble, defaults.userBubble),
    assistantBubble: pick(shape.assistantBubble, input.assistantBubble, defaults.assistantBubble),
    userTextColor: pick(shape.userTextColor, input.userTextColor, null),
    assistantTextColor: pick(shape.assistantTextColor, input.assistantTextColor, null),
    userBubbleColor: pick(shape.userBubbleColor, input.userBubbleColor, null),
    assistantSurfaceColor: pick(shape.assistantSurfaceColor, input.assistantSurfaceColor, null),
    title: pick(shape.title, input.title, null),
    headerTitleColor: pick(shape.headerTitleColor, input.headerTitleColor, null),
    headerColor: pick(shape.headerColor, input.headerColor, null),
    footerColor: pick(shape.footerColor, input.footerColor, null),
    background: {
      mode: pick(backgroundShape.mode, backgroundInput.mode, defaults.background.mode),
      focalX: pick(backgroundShape.focalX, backgroundInput.focalX, defaults.background.focalX),
      focalY: pick(backgroundShape.focalY, backgroundInput.focalY, defaults.background.focalY),
      dim: pick(backgroundShape.dim, backgroundInput.dim, defaults.background.dim),
    },
    requestMore: pick(shape.requestMore, input.requestMore, defaults.requestMore),
  }
}

/** Key-order independent comparison; stored JSONB does not preserve key order. */
export function chatAppearanceEquals(left: unknown, right: unknown): boolean {
  if (left === null || right === null || left === undefined || right === undefined) {
    return (left ?? null) === (right ?? null)
  }
  return JSON.stringify(parseChatAppearance(left)) === JSON.stringify(parseChatAppearance(right))
}

/** Compact URL-safe encoding used by the unsaved appearance preview link. */
export function encodeChatAppearanceParam(appearance: ChatAppearance): string {
  const json = JSON.stringify(appearance)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

export function decodeChatAppearanceParam(value: string | null | undefined): ChatAppearance | null {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null
  try {
    const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/')
    const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return parseChatAppearance(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    return null
  }
}
