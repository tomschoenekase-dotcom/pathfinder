import {
  decodeChatAppearanceParam,
  parseChatAppearance,
  type ChatAppearance,
} from '@pathfinder/contracts/chat-appearance'
import { CHAT_FONT_OPTIONS, CHAT_THEME_PRESETS, isHexColor } from '@pathfinder/ui/theme'

export { appearancePreviewParentOrigin } from './preview-origin'

type PreviewParams = {
  theme?: string | string[]
  font?: string | string[]
  accent?: string | string[]
  appearance?: string | string[]
  background?: string | string[]
  logo?: string | string[]
  name?: string | string[]
  embed?: string | string[]
}

/**
 * The preview only ever loads a reviewed venue-media derivative (or a local development
 * fixture) by path; arbitrary URLs are ignored.
 */
const PREVIEW_MEDIA_PATH =
  /^\/api\/venue-media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?venue=[A-Za-z0-9._~%-]{1,200}$|^\/dev-fixtures\/[a-z0-9-]{1,80}\.svg$/u

const PREVIEW_BLOB_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const PREVIEW_BLOB_MAX_BYTES = 12 * 1024 * 1024

export function parsePreviewBackground(value: string | undefined): string | undefined {
  return value && PREVIEW_MEDIA_PATH.test(value) ? value : undefined
}

export const parsePreviewMediaPath = parsePreviewBackground

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function previewName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.replace(/\s+/gu, ' ').trim()
  return name && name.length <= 120 ? name : undefined
}

/** A stage-only, data-free preview of the actual visitor shell. */
export function appearancePreviewAllowed(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  if (environment.RAILWAY_ENVIRONMENT === 'production') return false
  return environment.RAILWAY_ENVIRONMENT === 'staging' || environment.NODE_ENV === 'development'
}

export type AppearancePreviewMedia =
  | { kind: 'path'; path: string }
  | { kind: 'blob'; blob: Blob }
  | null

export type AppearancePreviewState = {
  theme: string
  font: string
  accent: string | undefined
  appearance: ChatAppearance | undefined
  background: AppearancePreviewMedia
  logo: AppearancePreviewMedia
  venueName: string | undefined
}

function parseTheme(value: unknown) {
  return value === 'dark' || CHAT_THEME_PRESETS.some((preset) => preset.value === value)
    ? (value as string)
    : 'default'
}

function parseFont(value: unknown) {
  return CHAT_FONT_OPTIONS.some((font) => font.value === value) ? (value as string) : 'jakarta'
}

export function parseAppearancePreviewParams(params: PreviewParams) {
  const background = parsePreviewBackground(first(params.background))
  const logo = parsePreviewMediaPath(first(params.logo))
  const accent = first(params.accent)
  return {
    theme: parseTheme(first(params.theme)),
    font: parseFont(first(params.font)),
    accent: isHexColor(accent) ? accent : undefined,
    appearance: decodeChatAppearanceParam(first(params.appearance)) ?? undefined,
    background,
    logo,
    venueName: previewName(first(params.name)),
    embedded: first(params.embed) === '1',
  }
}

function parseMedia(value: unknown): AppearancePreviewMedia | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object') return undefined
  const media = value as { kind?: unknown; path?: unknown; blob?: unknown }
  if (media.kind === 'path' && typeof media.path === 'string') {
    const path = parsePreviewMediaPath(media.path)
    return path ? { kind: 'path', path } : undefined
  }
  if (
    media.kind === 'blob' &&
    typeof Blob !== 'undefined' &&
    media.blob instanceof Blob &&
    PREVIEW_BLOB_TYPES.has(media.blob.type) &&
    media.blob.size > 0 &&
    media.blob.size <= PREVIEW_BLOB_MAX_BYTES
  ) {
    return { kind: 'blob', blob: media.blob }
  }
  return undefined
}

export const APPEARANCE_PREVIEW_MESSAGE = 'torchiko:appearance-preview'
export const APPEARANCE_PREVIEW_READY = 'torchiko:appearance-preview-ready'

/**
 * Validates a draft sent by the client portal. Every field passes the same allow-lists as the
 * URL parameters; anything unrecognised is dropped rather than rendered.
 */
export function parseAppearancePreviewMessage(data: unknown): AppearancePreviewState | null {
  if (!data || typeof data !== 'object') return null
  const message = data as Record<string, unknown>
  if (message.type !== APPEARANCE_PREVIEW_MESSAGE || message.version !== 1) return null
  const background = parseMedia(message.background)
  const logo = parseMedia(message.logo)
  return {
    theme: parseTheme(message.theme),
    font: parseFont(message.font),
    accent: isHexColor(message.accent as string | undefined)
      ? (message.accent as string)
      : undefined,
    appearance:
      message.appearance && typeof message.appearance === 'object'
        ? parseChatAppearance(message.appearance)
        : undefined,
    background: background ?? null,
    logo: logo ?? null,
    venueName: previewName(message.venueName),
  }
}
