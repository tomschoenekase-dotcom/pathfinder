import { describe, expect, it } from 'vitest'

import {
  APPEARANCE_PREVIEW_MESSAGE,
  appearancePreviewAllowed,
  appearancePreviewParentOrigin,
  parseAppearancePreviewMessage,
  parseAppearancePreviewParams,
} from './preview-params'

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
    expect(appearancePreviewAllowed({ NODE_ENV: 'test' })).toBe(false)
  })

  it('accepts stored theme choices and a valid accent but never passes arbitrary preview values', () => {
    expect(
      parseAppearancePreviewParams({ theme: 'forest', font: 'inter', accent: '#245A4A' }),
    ).toMatchObject({
      theme: 'forest',
      font: 'inter',
      accent: '#245A4A',
      embedded: false,
    })
    expect(
      parseAppearancePreviewParams({
        theme: '<script>',
        font: 'external-font',
        accent: 'url(https://example.com/logo)',
        logo: 'https://evil.example/logo.png',
        background: '//evil.example/photo.jpg',
        name: 'x'.repeat(200),
      }),
    ).toMatchObject({
      theme: 'default',
      font: 'jakarta',
      accent: undefined,
      logo: undefined,
      background: undefined,
      venueName: undefined,
    })
  })

  it('loads only reviewed venue media paths for the logo and background', () => {
    const path = '/api/venue-media/12222222-2222-4222-8222-222222222222?venue=maple-hollow'
    expect(
      parseAppearancePreviewParams({
        logo: path,
        background: path,
        name: '  Maple   Hollow ',
        embed: '1',
      }),
    ).toMatchObject({ logo: path, background: path, venueName: 'Maple Hollow', embedded: true })
  })
})

describe('client-portal framing origin', () => {
  it('comes only from the service’s own configured dashboard origin', () => {
    expect(
      appearancePreviewParentOrigin({
        DASHBOARD_URL: 'https://app.staging.torchiko.com/some/path',
      }),
    ).toBe('https://app.staging.torchiko.com')
    expect(appearancePreviewParentOrigin({ NODE_ENV: 'development' })).toBe('http://localhost:3001')
    expect(appearancePreviewParentOrigin({ NODE_ENV: 'production' })).toBeNull()
    expect(appearancePreviewParentOrigin({ DASHBOARD_URL: 'http://app.example.com' })).toBeNull()
    expect(
      appearancePreviewParentOrigin({
        DASHBOARD_URL: 'http://localhost:3001',
        NODE_ENV: 'production',
      }),
    ).toBeNull()
    expect(
      appearancePreviewParentOrigin({ DASHBOARD_URL: 'https://u:p@app.example.com' }),
    ).toBeNull()
    expect(appearancePreviewParentOrigin({ DASHBOARD_URL: 'not a url' })).toBeNull()
  })
})

describe('portal draft messages', () => {
  const base = {
    type: APPEARANCE_PREVIEW_MESSAGE,
    version: 1,
    theme: 'forest',
    font: 'inter',
    accent: '#245A4A',
    venueName: 'Maple Hollow',
    appearance: {
      version: 1,
      userBubble: true,
      assistantBubble: true,
      userBubbleColor: '#DDEBE3',
      userTextColor: '#1C1C1C',
      assistantSurfaceColor: '#1F3A5F',
      assistantTextColor: '#FFFFFF',
    },
    logo: null,
    background: null,
  }

  it('applies all four message colours through the same tolerant appearance parser', () => {
    const parsed = parseAppearancePreviewMessage(base)
    expect(parsed?.appearance).toMatchObject({
      userBubbleColor: '#DDEBE3',
      userTextColor: '#1C1C1C',
      assistantSurfaceColor: '#1F3A5F',
      assistantTextColor: '#FFFFFF',
    })
    expect(parsed).toMatchObject({ theme: 'forest', font: 'inter', venueName: 'Maple Hollow' })
  })

  it('ignores anything that is not a current portal draft, and drops unsafe media', () => {
    expect(parseAppearancePreviewMessage({ ...base, type: 'other' })).toBeNull()
    expect(parseAppearancePreviewMessage({ ...base, version: 2 })).toBeNull()
    expect(parseAppearancePreviewMessage('torchiko:appearance-preview')).toBeNull()
    const unsafe = parseAppearancePreviewMessage({
      ...base,
      theme: 'javascript:',
      accent: 'red',
      logo: { kind: 'path', path: 'https://evil.example/logo.png' },
      background: { kind: 'blob', blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }) },
    })
    expect(unsafe).toMatchObject({
      theme: 'default',
      accent: undefined,
      logo: null,
      background: null,
    })
  })

  it('accepts a local draft image only as a small raster blob', () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    expect(
      parseAppearancePreviewMessage({ ...base, logo: { kind: 'blob', blob: png } })?.logo,
    ).toEqual({
      kind: 'blob',
      blob: png,
    })
  })
})
