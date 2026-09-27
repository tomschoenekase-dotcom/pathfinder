import { describe, expect, it } from 'vitest'

import {
  buildWidgetFrameAncestors,
  extractExactEmbedVenueSlug,
  extractExactWebsiteEmbedVenueSlug,
  SELF_ONLY_FRAME_ANCESTORS,
} from './widget-origin-policy'

describe('widget origin policy', () => {
  it('accepts normalized, sorted, exact HTTPS origins from the durable resolver', () => {
    expect(
      buildWidgetFrameAncestors([
        'https://B.example:443',
        'https://a.example/',
        'https://b.example',
      ]),
    ).toBe("frame-ancestors 'self' https://a.example https://b.example")
  })

  it.each(
    [
      ['http://museum.example'],
      ['https://user:password@museum.example'],
      ['https://museum.example/path'],
      ['https://*.example.com'],
      ['https://müséum.example'],
      Array.from({ length: 21 }, (_, index) => `https://${index}.example`),
    ].map((origins) => ({ origins })),
  )('fails closed for invalid or oversized origin sets', ({ origins }) => {
    expect(buildWidgetFrameAncestors(origins)).toBe(SELF_ONLY_FRAME_ANCESTORS)
  })

  it('fails self-only when normalized origins would exceed the CSP byte cap', () => {
    const longOrigins = Array.from(
      { length: 20 },
      (_, index) =>
        `https://${index}.${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example:65535`,
    )
    expect(buildWidgetFrameAncestors(longOrigins)).toBe(SELF_ONLY_FRAME_ANCESTORS)
  })

  it.each([
    '/embed',
    '/embed/',
    '/embed/Museum',
    '/embed/museum/extra',
    '/embed/museum%2Fextra',
    `/embed/${'a'.repeat(201)}`,
  ])('rejects ambiguous or noncanonical embed path %s', (pathname) => {
    expect(extractExactEmbedVenueSlug(pathname)).toBeNull()
  })

  it('extracts a canonical venue slug for middleware lookup', () => {
    expect(extractExactEmbedVenueSlug('/embed/city-sc')).toBe('city-sc')
  })

  it('accepts only the canonical inline website document suffix', () => {
    expect(extractExactWebsiteEmbedVenueSlug('/embed/city-sc/inline')).toBe('city-sc')
    for (const pathname of [
      '/embed/city-sc/inline/extra',
      '/embed/city-sc/app',
      '/embed/city-sc/inline.html',
    ]) {
      expect(extractExactWebsiteEmbedVenueSlug(pathname)).toBeNull()
    }
  })
})
