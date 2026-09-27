import { describe, expect, it } from 'vitest'

import { buildVenueAccessArtifacts } from './venue-access-artifacts'

describe('venue access artifacts', () => {
  it('derives every visitor entry from the configured origin and slug', () => {
    expect(buildVenueAccessArtifacts('https://guide.example.com/', 'city-sc')).toEqual({
      publicUrl: 'https://guide.example.com/city-sc/chat',
      qrUrl: 'https://guide.example.com/city-sc/chat?source=qr',
      launcherSnippet:
        '<script src="https://guide.example.com/widget.js" data-torchiko-venue="city-sc" async></script>',
      inlineSnippet:
        '<div data-torchiko-inline="city-sc" style="height: 720px"></div>\n<script src="https://guide.example.com/widget.js" async></script>',
      appUrl: 'https://guide.example.com/app/city-sc',
      compactAppUrl: 'https://guide.example.com/app/city-sc?header=compact',
      appBackground: null,
      hostGuideUrl: null,
    })
  })

  it('exposes only a validated app background color for native host configuration', () => {
    expect(
      buildVenueAccessArtifacts('https://guide.example.com', 'museum', {
        appBackground: '#0d1116',
      })?.appBackground,
    ).toBe('#0d1116')
    expect(
      buildVenueAccessArtifacts('https://guide.example.com', 'museum', {
        appBackground: 'url(javascript:alert(1))',
      }),
    ).toBeNull()
  })

  it('allows loopback HTTP only when explicitly enabled', () => {
    expect(buildVenueAccessArtifacts('http://localhost:3000', 'museum')).toBeNull()
    expect(
      buildVenueAccessArtifacts('http://localhost:3000', 'museum', { allowLoopbackHttp: true }),
    ).toMatchObject({ appUrl: 'http://localhost:3000/app/museum' })
  })

  it.each([
    ['not an origin', 'museum'],
    ['https://guide.example.com/path', 'museum'],
    ['https://user:secret@guide.example.com', 'museum'],
    ['https://guide.example.com', '../museum'],
    ['https://guide.example.com', '.'],
    ['https://guide.example.com', '..'],
    ['https://guide.example.com', 'Museum'],
    ['https://guide.example.com', 'city sc'],
    ['https://guide.example.com', 'city--sc'],
    ['https://guide.example.com', 'museo-ñ'],
    ['https://guide.example.com', ' city-sc '],
  ])('rejects ambiguous origin or slug input', (origin, slug) => {
    expect(buildVenueAccessArtifacts(origin, slug)).toBeNull()
  })
})
