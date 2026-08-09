import { describe, expect, it } from 'vitest'

import {
  buildWidgetFrameAncestors,
  extractExactEmbedVenueSlug,
  parseWidgetOriginPolicy,
  SELF_ONLY_FRAME_ANCESTORS,
} from './widget-origin-policy'

describe('widget origin policy', () => {
  it('normalizes, deduplicates, and sorts exact HTTPS origins', () => {
    expect(
      parseWidgetOriginPolicy(
        JSON.stringify({
          museum: ['https://B.example:443', 'https://a.example/', 'https://b.example'],
        }),
      ),
    ).toEqual(new Map([['museum', ['https://a.example', 'https://b.example']]]))
  })

  it.each([
    '{',
    '[]',
    'null',
    JSON.stringify({ museum: 'https://museum.example' }),
    JSON.stringify({ Museum: ['https://museum.example'] }),
    JSON.stringify({ museum: ['*'] }),
    JSON.stringify({ museum: ['https://*.example.com'] }),
    JSON.stringify({ museum: ['https://*'] }),
    JSON.stringify({ museum: ['https://%2A.example.com'] }),
    JSON.stringify({ museum: [' https://museum.example'] }),
    JSON.stringify({ museum: ['https://museum.example\n'] }),
    JSON.stringify({ museum: ['https://müséum.example'] }),
    JSON.stringify({ museum: ['http://museum.example'] }),
    JSON.stringify({ museum: ['https://user:password@museum.example'] }),
    JSON.stringify({ museum: ['https://museum.example/path'] }),
    JSON.stringify({ museum: ['https://museum.example/.'] }),
    JSON.stringify({ museum: ['https://museum.example?'] }),
    JSON.stringify({ museum: ['https://museum.example#'] }),
    JSON.stringify({ museum: ['https://museum.example?query=1'] }),
    JSON.stringify({ museum: ['https://museum.example#fragment'] }),
    JSON.stringify({
      museum: Array.from({ length: 21 }, (_, index) => `https://${index}.example`),
    }),
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [`venue-${index}`, ['https://host.example']]),
      ),
    ),
    JSON.stringify({ museum: ['https://museum.example'] }).padEnd(16_385, ' '),
  ])('fails the complete policy closed for invalid input %#', (rawPolicy) => {
    expect(parseWidgetOriginPolicy(rawPolicy)).toBeNull()
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

  it('admits external framing only for an exact enabled venue policy', () => {
    const environment = {
      RAILWAY_ENVIRONMENT: 'staging',
      EMBED_PREVIEW_ENABLED: 'true',
      WIDGET_PREVIEW_ORIGINS_JSON: JSON.stringify({
        museum: ['https://venue.example', 'https://events.example'],
      }),
    }

    expect(buildWidgetFrameAncestors('/embed/museum', environment)).toBe(
      "frame-ancestors 'self' https://events.example https://venue.example",
    )
    expect(buildWidgetFrameAncestors('/embed/other', environment)).toBe(SELF_ONLY_FRAME_ANCESTORS)
  })

  it('fails the rendered directive closed before a proxy-sized header is exceeded', () => {
    const longOrigins = Array.from(
      { length: 20 },
      (_, index) =>
        `https://${index}.${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example:65535`,
    )

    expect(
      buildWidgetFrameAncestors('/embed/museum', {
        RAILWAY_ENVIRONMENT: 'staging',
        EMBED_PREVIEW_ENABLED: 'true',
        WIDGET_PREVIEW_ORIGINS_JSON: JSON.stringify({ museum: longOrigins }),
      }),
    ).toBe(SELF_ONLY_FRAME_ANCESTORS)
  })

  it.each([
    {},
    { RAILWAY_ENVIRONMENT: 'production', EMBED_PREVIEW_ENABLED: 'true' },
    { RAILWAY_ENVIRONMENT: 'preview', EMBED_PREVIEW_ENABLED: 'true' },
    { RAILWAY_ENVIRONMENT: 'staging', EMBED_PREVIEW_ENABLED: 'false' },
    { RAILWAY_ENVIRONMENT: 'staging', EMBED_PREVIEW_ENABLED: 'TRUE' },
    {
      RAILWAY_ENVIRONMENT: 'staging',
      EMBED_PREVIEW_ENABLED: 'true',
      WIDGET_PREVIEW_ORIGINS_JSON: '{',
    },
  ])('retains self-only framing for disabled or invalid configuration %#', (environment) => {
    expect(buildWidgetFrameAncestors('/embed/museum', environment)).toBe(SELF_ONLY_FRAME_ANCESTORS)
  })
})
