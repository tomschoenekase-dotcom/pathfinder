export type ChatThemeValue = 'default' | 'forest' | 'sunset' | 'midnight' | 'rose' | 'dark'

export type ChatFontValue = 'jakarta' | 'inter' | 'poppins' | 'spaceGrotesk' | 'dmSans' | 'playfair'

export type ChatPalette = {
  accent: string
  accentText: string
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
  { value: 'default', label: 'Torchiko Blue', accent: '#306CC4', surface: '#F2F5F9' },
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

// Deep enough for white button text (5.2:1) and for links on the default surface (4.7:1).
const DEFAULT_ACCENT = '#306CC4'
const LIGHT_ACCENT_TEXT = '#FFFFFF'
const DARK_ACCENT_TEXT = '#000000'

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
  const hh = (((h % 360) + 360) % 360) / 360

  const r = Math.round(hueToRgb(p, q, hh + 1 / 3) * 255)
  const g = Math.round(hueToRgb(p, q, hh) * 255)
  const b = Math.round(hueToRgb(p, q, hh - 1 / 3) * 255)

  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

function relativeLuminance(hex: string): number {
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((channel) => {
    const value = parseInt(channel, 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function accessibleAccentText(accent: string): string {
  return contrastRatio(accent, LIGHT_ACCENT_TEXT) >= 4.5 ? LIGHT_ACCENT_TEXT : DARK_ACCENT_TEXT
}

function accessibleAccentOnSurfaces(accent: string, surfaces: readonly string[]): string {
  if (surfaces.every((surface) => contrastRatio(accent, surface) >= 4.5)) return accent

  const { h, s, l } = hexToHsl(accent)
  for (let lightness = Math.min(l, 0.45); lightness >= 0.08; lightness -= 0.01) {
    const candidate = hslToHex(h, s, lightness)
    if (surfaces.every((surface) => contrastRatio(candidate, surface) >= 4.5)) return candidate
  }

  return '#0F2A4A'
}

/**
 * Derives a neon-dark palette from a venue's existing brand accent, preserving
 * the brand hue so every venue's dark mode looks distinct rather than a shared preset.
 */
export function deriveNeonPalette(baseHex: string): ChatPalette {
  const { h } = hexToHsl(isHexColor(baseHex) ? baseHex : DEFAULT_ACCENT)

  return {
    accent: hslToHex(h, 0.9, 0.6),
    accentText: hslToHex(h, 0.9, 0.6),
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

  const accent = isHexColor(accentOverride) ? accentOverride : preset.accent
  const card = '#FFFFFF'
  const accentText = accessibleAccentOnSurfaces(accent, [preset.surface, card])

  return {
    accent,
    accentText,
    accentContrast: accessibleAccentText(accent),
    bg: preset.surface,
    card,
    border: '#C9D4E3',
    text: '#0F2A4A',
    textMuted: '#59697E',
    isDark: false,
  }
}

// ---------------------------------------------------------------------------
// Venue appearance tokens
// ---------------------------------------------------------------------------

export type ChatAppearanceInput = {
  userBubble: boolean
  assistantBubble: boolean
  userTextColor: string | null
  assistantTextColor: string | null
  userBubbleColor: string | null
  assistantSurfaceColor: string | null
  headerTitleColor: string | null
  headerColor: string | null
  footerColor: string | null
  background: { mode: 'none' | 'image'; focalX: number; focalY: number; dim: number }
}

export type ChatAppearanceCorrectionField =
  | 'userTextColor'
  | 'assistantTextColor'
  | 'headerTitleColor'

export type ChatAppearanceCorrection = {
  field: ChatAppearanceCorrectionField
  requested: string
  applied: string
  ratio: number
}

export type ChatAppearanceTokens = {
  pageBg: string
  pageText: string
  pageMuted: string
  headerBg: string
  headerText: string
  headerMuted: string
  headerAccent: string
  headerBorder: string
  footerBg: string
  footerText: string
  footerMuted: string
  footerBorder: string
  fieldBg: string
  fieldText: string
  fieldMuted: string
  fieldBorder: string
  /** True when the visitor's words sit on a surface (their bubble or image protection). */
  userSurface: boolean
  userBg: string
  userText: string
  userBorder: string
  assistantBubble: boolean
  /** True when the answer gets a reading surface only because an image is behind it. */
  assistantProtected: boolean
  assistantBg: string
  assistantText: string
  assistantBorder: string
  speakerLabels: boolean
  speakerLabelColor: string
  actionBg: string
  actionText: string
  actionBorder: string
  backgroundImage: boolean
  backgroundPosition: string
  backgroundOverlay: string
  isDarkChrome: boolean
  corrections: ChatAppearanceCorrection[]
}

/** WCAG AA for body text; every text/surface pair below must meet it. */
export const CHAT_TEXT_CONTRAST_MINIMUM = 4.5

export function chatContrastRatio(first: string, second: string): number {
  return contrastRatio(first, second)
}

export function mixHexColors(first: string, second: string, weightOfFirst: number): string {
  const weight = Math.max(0, Math.min(1, weightOfFirst))
  const channels = [1, 3, 5].map((offset) => {
    const a = parseInt(first.slice(offset, offset + 2), 16)
    const b = parseInt(second.slice(offset, offset + 2), 16)
    return Math.round(a * weight + b * (1 - weight))
      .toString(16)
      .padStart(2, '0')
  })
  return `#${channels.join('')}`
}

function isDarkColor(hex: string): boolean {
  return relativeLuminance(hex) < 0.18
}

function bestTextOn(surface: string, preferred: readonly string[]): string {
  for (const candidate of preferred) {
    if (contrastRatio(candidate, surface) >= CHAT_TEXT_CONTRAST_MINIMUM) return candidate
  }
  return contrastRatio('#FFFFFF', surface) >= contrastRatio('#000000', surface)
    ? '#FFFFFF'
    : '#000000'
}

function mutedOn(surface: string, text: string): string {
  for (const weight of [0.62, 0.7, 0.8, 0.9]) {
    const candidate = mixHexColors(text, surface, weight)
    if (contrastRatio(candidate, surface) >= CHAT_TEXT_CONTRAST_MINIMUM) return candidate
  }
  return text
}

function hexToRgbTriplet(hex: string): string {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(' ')
}

function roundedRatio(first: string, second: string): number {
  return Math.round(contrastRatio(first, second) * 100) / 100
}

/**
 * Resolves a venue appearance into concrete colors. Venue choices are honored when they are
 * readable; any unreadable text/surface pair is corrected and reported so the editor can warn.
 * On an image background both speakers get an opaque reading surface automatically.
 */
export function resolveChatAppearance(
  palette: ChatPalette,
  appearance: ChatAppearanceInput,
  options: { hasBackgroundImage?: boolean; highContrast?: boolean } = {},
): ChatAppearanceTokens {
  const corrections: ChatAppearanceCorrection[] = []

  function honor(
    field: ChatAppearanceCorrectionField,
    requested: string | null,
    surface: string,
    fallbacks: readonly string[],
  ): string {
    if (isHexColor(requested)) {
      if (contrastRatio(requested, surface) >= CHAT_TEXT_CONTRAST_MINIMUM) return requested
      const applied = bestTextOn(surface, fallbacks)
      corrections.push({ field, requested, applied, ratio: roundedRatio(requested, surface) })
      return applied
    }
    return bestTextOn(surface, fallbacks)
  }

  const speakerLabels = !appearance.userBubble && !appearance.assistantBubble

  if (options.highContrast) {
    const dark = palette.isDark
    const bg = dark ? '#000000' : '#FFFFFF'
    const text = dark ? '#FFFFFF' : '#000000'
    const accent = dark ? '#FFFFFF' : accessibleAccentOnSurfaces(palette.accent, [bg])
    return {
      pageBg: bg,
      pageText: text,
      pageMuted: text,
      headerBg: bg,
      headerText: text,
      headerMuted: text,
      headerAccent: accent,
      headerBorder: text,
      footerBg: bg,
      footerText: text,
      footerMuted: text,
      footerBorder: text,
      fieldBg: bg,
      fieldText: text,
      fieldMuted: text,
      fieldBorder: text,
      userSurface: true,
      userBg: bg,
      userText: text,
      userBorder: text,
      assistantBubble: appearance.assistantBubble,
      assistantProtected: false,
      assistantBg: bg,
      assistantText: text,
      assistantBorder: appearance.assistantBubble ? text : 'transparent',
      speakerLabels,
      speakerLabelColor: text,
      actionBg: bg,
      actionText: accent,
      actionBorder: text,
      backgroundImage: false,
      backgroundPosition: '50% 50%',
      backgroundOverlay: 'transparent',
      isDarkChrome: dark,
      corrections: [],
    }
  }

  const backgroundImage = Boolean(
    options.hasBackgroundImage && appearance.background.mode === 'image',
  )
  const pageBg = palette.bg
  const headerBg = isHexColor(appearance.headerColor) ? appearance.headerColor : palette.card
  // The bottom bar follows the header when the venue colors the header; otherwise it keeps
  // the page surface so the default presentation is unchanged.
  const footerBg = isHexColor(appearance.footerColor)
    ? appearance.footerColor
    : isHexColor(appearance.headerColor)
      ? appearance.headerColor
      : palette.bg
  const headerText = honor('headerTitleColor', appearance.headerTitleColor, headerBg, [
    palette.text,
    '#FFFFFF',
  ])
  const headerMuted = mutedOn(headerBg, headerText)
  // Icons need 3:1 against their surface (WCAG 1.4.11).
  const headerAccent =
    contrastRatio(palette.accentText, headerBg) >= 3
      ? palette.accentText
      : contrastRatio(palette.accent, headerBg) >= 3
        ? palette.accent
        : headerText
  const footerText = bestTextOn(footerBg, [palette.text, '#FFFFFF'])
  const footerMuted = mutedOn(footerBg, footerText)
  const darkFooter = isDarkColor(footerBg)
  const fieldBg = darkFooter ? mixHexColors('#FFFFFF', footerBg, 0.08) : palette.card
  const fieldText = bestTextOn(fieldBg, [palette.text, '#FFFFFF'])

  // A reading surface is the solid color under text whenever a bubble is shown or an image
  // would otherwise sit directly behind the words.
  const neutralSurface = palette.card
  const userSurface = appearance.userBubble || backgroundImage
  const userBg = userSurface
    ? isHexColor(appearance.userBubbleColor)
      ? appearance.userBubbleColor
      : appearance.userBubble
        ? mixHexColors(
            palette.accent,
            palette.isDark ? palette.bg : '#FFFFFF',
            palette.isDark ? 0.3 : 0.16,
          )
        : neutralSurface
    : pageBg
  const userText = honor('userTextColor', appearance.userTextColor, userBg, [
    palette.text,
    '#FFFFFF',
  ])
  const assistantSurface = appearance.assistantBubble || backgroundImage
  const assistantBg = assistantSurface
    ? isHexColor(appearance.assistantSurfaceColor)
      ? appearance.assistantSurfaceColor
      : neutralSurface
    : pageBg
  const assistantText = honor('assistantTextColor', appearance.assistantTextColor, assistantBg, [
    palette.text,
    '#FFFFFF',
  ])
  const labelSurface = backgroundImage ? assistantBg : pageBg
  const actionBg = backgroundImage ? assistantBg : pageBg
  const actionText =
    contrastRatio(palette.accentText, actionBg) >= CHAT_TEXT_CONTRAST_MINIMUM
      ? palette.accentText
      : bestTextOn(actionBg, [palette.text, '#FFFFFF'])
  const dim = Math.max(0, Math.min(85, appearance.background.dim)) / 100
  const overlayBase = palette.isDark || isDarkColor(headerBg) ? '0 0 0' : hexToRgbTriplet(pageBg)

  return {
    pageBg,
    pageText: palette.text,
    pageMuted: palette.textMuted,
    headerBg,
    headerText,
    headerMuted,
    headerAccent,
    headerBorder: isDarkColor(headerBg) ? mixHexColors('#FFFFFF', headerBg, 0.14) : palette.border,
    footerBg,
    footerText,
    footerMuted,
    footerBorder: darkFooter ? mixHexColors('#FFFFFF', footerBg, 0.14) : palette.border,
    fieldBg,
    fieldText,
    fieldMuted: mutedOn(fieldBg, fieldText),
    fieldBorder: darkFooter ? mixHexColors('#FFFFFF', footerBg, 0.24) : palette.border,
    userSurface,
    userBg,
    userText,
    userBorder: userSurface && !appearance.userBubble ? palette.border : 'transparent',
    assistantBubble: appearance.assistantBubble,
    assistantProtected: backgroundImage && !appearance.assistantBubble,
    assistantBg,
    assistantText,
    assistantBorder: assistantSurface ? palette.border : 'transparent',
    speakerLabels,
    speakerLabelColor: mutedOn(labelSurface, bestTextOn(labelSurface, [palette.text, '#FFFFFF'])),
    actionBg,
    actionText,
    actionBorder: palette.border,
    backgroundImage,
    backgroundPosition: `${appearance.background.focalX}% ${appearance.background.focalY}%`,
    backgroundOverlay: `rgb(${overlayBase} / ${dim})`,
    isDarkChrome: isDarkColor(headerBg),
    corrections,
  }
}
