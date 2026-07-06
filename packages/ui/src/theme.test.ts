import { describe, expect, it } from 'vitest'

import { deriveNeonPalette, getChatPalette } from './theme'

function hexToLightness(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2
}

describe('deriveNeonPalette', () => {
  it('produces a dark background, card, and border', () => {
    const palette = deriveNeonPalette('#3A7BD5')

    expect(hexToLightness(palette.bg)).toBeLessThan(0.15)
    expect(hexToLightness(palette.card)).toBeLessThan(0.2)
    expect(hexToLightness(palette.border)).toBeLessThan(0.3)
    expect(palette.isDark).toBe(true)
  })

  it('produces a bright accent with a dark contrast color', () => {
    const palette = deriveNeonPalette('#2D6A4F')

    expect(hexToLightness(palette.accent)).toBeGreaterThan(0.45)
    expect(hexToLightness(palette.accentContrast)).toBeLessThan(0.15)
  })

  it('falls back to the default accent hue for a non-hex input', () => {
    const fallback = deriveNeonPalette('not-a-color')
    const explicit = deriveNeonPalette('#3A7BD5')

    expect(fallback.accent).toBe(explicit.accent)
  })
})

describe('getChatPalette', () => {
  it('returns a light palette for preset themes', () => {
    const palette = getChatPalette('forest', null)

    expect(palette.isDark).toBe(false)
    expect(palette.accent).toBe('#2D6A4F')
  })

  it('returns a derived neon palette for the dark theme using the accent override', () => {
    const withOverride = getChatPalette('dark', '#E07B39')
    const derived = deriveNeonPalette('#E07B39')

    expect(withOverride).toEqual(derived)
  })

  it('falls back to the default preset accent for dark theme with no override', () => {
    const palette = getChatPalette('dark', null)
    expect(palette.accent).toBe(deriveNeonPalette('#3A7BD5').accent)
  })
})
