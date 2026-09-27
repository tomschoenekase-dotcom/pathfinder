import { decodeChatAppearanceParam } from '@pathfinder/contracts/chat-appearance'
import { CHAT_FONT_OPTIONS, CHAT_THEME_PRESETS, isHexColor } from '@pathfinder/ui/theme'

type PreviewParams = {
  theme?: string | string[]
  font?: string | string[]
  accent?: string | string[]
  appearance?: string | string[]
  background?: string | string[]
}

/**
 * The preview only ever loads a reviewed venue-media derivative (or a local development
 * fixture) as its background; arbitrary URLs are ignored.
 */
const PREVIEW_BACKGROUND_PATH =
  /^\/api\/venue-media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?venue=[A-Za-z0-9._~%-]{1,200}$|^\/dev-fixtures\/[a-z0-9-]{1,80}\.svg$/u

export function parsePreviewBackground(value: string | undefined): string | undefined {
  return value && PREVIEW_BACKGROUND_PATH.test(value) ? value : undefined
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** A stage-only, data-free preview of the actual visitor shell. */
export function appearancePreviewAllowed(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  if (environment.RAILWAY_ENVIRONMENT === 'production') return false
  return environment.RAILWAY_ENVIRONMENT === 'staging' || environment.NODE_ENV === 'development'
}

export function parseAppearancePreviewParams(params: PreviewParams) {
  const requestedTheme = first(params.theme)
  const requestedFont = first(params.font)
  const requestedAccent = first(params.accent)
  return {
    theme:
      requestedTheme === 'dark' ||
      CHAT_THEME_PRESETS.some((preset) => preset.value === requestedTheme)
        ? requestedTheme
        : 'default',
    font: CHAT_FONT_OPTIONS.some((font) => font.value === requestedFont)
      ? requestedFont
      : 'jakarta',
    accent: isHexColor(requestedAccent) ? requestedAccent : undefined,
    appearance: decodeChatAppearanceParam(first(params.appearance)) ?? undefined,
    background: parsePreviewBackground(first(params.background)),
  }
}
