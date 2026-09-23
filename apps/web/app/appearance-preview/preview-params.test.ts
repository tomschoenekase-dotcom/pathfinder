import { describe, expect, it } from 'vitest'

import { appearancePreviewAllowed, parseAppearancePreviewParams } from './preview-params'

describe('stage-only appearance preview boundary', () => {
  it('admits staging and local development, while refusing production and previews', () => {
    expect(
      appearancePreviewAllowed({ RAILWAY_ENVIRONMENT: 'staging', NODE_ENV: 'production' }),
    ).toBe(true)
    expect(appearancePreviewAllowed({ NODE_ENV: 'development' })).toBe(true)
    expect(
      appearancePreviewAllowed({ RAILWAY_ENVIRONMENT: 'production', NODE_ENV: 'production' }),
    ).toBe(false)
    expect(
      appearancePreviewAllowed({ RAILWAY_ENVIRONMENT: 'production', NODE_ENV: 'development' }),
    ).toBe(false)
    expect(
      appearancePreviewAllowed({ RAILWAY_ENVIRONMENT: 'preview', NODE_ENV: 'production' }),
    ).toBe(false)
  })

  it('accepts stored theme choices and a valid accent but never passes arbitrary preview values', () => {
    expect(
      parseAppearancePreviewParams({ theme: 'forest', font: 'inter', accent: '#245A4A' }),
    ).toEqual({
      theme: 'forest',
      font: 'inter',
      accent: '#245A4A',
    })
    expect(
      parseAppearancePreviewParams({
        theme: '<script>',
        font: 'external-font',
        accent: 'url(https://example.com/logo)',
      }),
    ).toEqual({ theme: 'default', font: 'jakarta', accent: undefined })
  })
})
