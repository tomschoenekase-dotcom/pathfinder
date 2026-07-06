export type ChatThemeValue = 'default' | 'forest' | 'sunset' | 'midnight' | 'rose' | 'dark'

export type ChatFontValue = 'jakarta' | 'inter' | 'poppins' | 'spaceGrotesk' | 'dmSans' | 'playfair'

export type ChatPalette = {
  accent: string
  accentContrast: string
  bg: string
  card: string
  border: string
  text: string
  textMuted: string
  isDark: boolean
}

export const CHAT_THEME_PRESETS: {
  value: Exclude<ChatThemeValue, 'dark'>
  label: string
  accent: string
  surface: string
}[] = [
  { value: 'default', label: 'PathFinder Blue', accent: '#3A7BD5', surface: '#F2F5F9' },
  { value: 'forest', label: 'Forest', accent: '#2D6A4F', surface: '#F0F7F4' },
  { value: 'sunset', label: 'Sunset', accent: '#E07B39', surface: '#FBF4EF' },
  { value: 'midnight', label: 'Midnight', accent: '#4361EE', surface: '#EEF0F8' },
  { value: 'rose', label: 'Rose', accent: '#D4607A', surface: '#FDF0F3' },
]

export const CHAT_FONT_OPTIONS: { value: ChatFontValue; label: string; cssVar: string }[] = [
  { value: 'jakarta', label: 'Plus Jakarta Sans', cssVar: '--font-jakarta' },
  { value: 'inter', label: 'Inter', cssVar: '--font-inter' },
  { value: 'poppins', label: 'Poppins', cssVar: '--font-poppins' },
  { value: 'spaceGrotesk', label: 'Space Grotesk', cssVar: '--font-space-grotesk' },
  { value: 'dmSans', label: 'DM Sans', cssVar: '--font-dm-sans' },
  { value: 'playfair', label: 'Playfair Display', cssVar: '--font-playfair' },
]

const DEFAULT_ACCENT = '#3A7BD5'

export function isHexColor(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value)
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  if (max === min) {
    return { h: 0, s: 0, l }
  }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

  let h: number
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0)
      break
    case g:
      h = (b - r) / d + 2
      break
    default:
      h = (r - g) / d + 4
  }
  h *= 60

  return { h, s, l }
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t
  if (tt < 0) tt += 1
  if (tt > 1) tt -= 1
  if (tt < 1 / 6) return p + (q - p) * 6 * tt
  if (tt < 1 / 2) return q
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
  return p
}

function hslToHex(h: number, s: number, l: number): string {
  if (s === 0) {
    const v = Math.round(l * 255)
    const hex = v.toString(16).padStart(2, '0')
    return `#${hex}${hex}${hex}`
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hh = ((h % 360) + 360) / 360

  const r = Math.round(hueToRgb(p, q, hh + 1 / 3) * 255)
  const g = Math.round(hueToRgb(p, q, hh) * 255)
  const b = Math.round(hueToRgb(p, q, hh - 1 / 3) * 255)

  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Derives a neon-dark palette from a venue's existing brand accent, preserving
 * the brand hue so every venue's dark mode looks distinct rather than a shared preset.
 */
export function deriveNeonPalette(baseHex: string): ChatPalette {
  const { h } = hexToHsl(isHexColor(baseHex) ? baseHex : DEFAULT_ACCENT)

  return {
    accent: hslToHex(h, 0.9, 0.6),
    accentContrast: hslToHex(h, 0.4, 0.08),
    bg: hslToHex(h, 0.25, 0.07),
    card: hslToHex(h, 0.22, 0.11),
    border: hslToHex(h, 0.3, 0.22),
    text: hslToHex(h, 0.15, 0.95),
    textMuted: hslToHex(h, 0.12, 0.65),
    isDark: true,
  }
}

export function getChatPalette(
  theme: string | null | undefined,
  accentOverride?: string | null,
): ChatPalette {
  if (theme === 'dark') {
    const preset = CHAT_THEME_PRESETS.find((p) => p.value === 'default')!
    const baseAccent = isHexColor(accentOverride) ? accentOverride : preset.accent
    return deriveNeonPalette(baseAccent)
  }

  const preset = CHAT_THEME_PRESETS.find((p) => p.value === theme) ?? CHAT_THEME_PRESETS[0]!

  return {
    accent: isHexColor(accentOverride) ? accentOverride : preset.accent,
    accentContrast: '#FFFFFF',
    bg: preset.surface,
    card: '#FFFFFF',
    border: '#C9D4E3',
    text: '#0F2A4A',
    textMuted: '#6B7C93',
    isDark: false,
  }
}
