import { CHAT_FONT_OPTIONS, CHAT_THEME_PRESETS, isHexColor } from '@pathfinder/ui/theme'

type PreviewParams = {
  theme?: string | string[]
  font?: string | string[]
  accent?: string | string[]
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
  }
}
