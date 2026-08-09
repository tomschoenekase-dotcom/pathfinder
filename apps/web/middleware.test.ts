import { NextRequest } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: vi.fn((handler: unknown) => handler),
}))

import middleware, { config, getEmbedResponseHeaders } from './middleware'

describe('embed middleware response boundary', () => {
  it.each([
    'https://guide.example/embed/museum',
    'https://guide.example/embed/museum.html',
    'https://guide.example/embed/museum.js',
    'https://guide.example/embed/icon.svg',
  ])('matches every embed-shaped response through the real Next matcher: %s', (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true)
  })

  it('does not pull the standalone widget loader into middleware', () => {
    expect(
      unstable_doesMiddlewareMatch({
        config,
        url: 'https://guide.example/widget.js',
      }),
    ).toBe(false)
  })

  it('leaves non-embed routes untouched', () => {
    expect(
      getEmbedResponseHeaders(new NextRequest('https://guide.example/museum'), {
        EMBED_PREVIEW_ENABLED: 'true',
      }),
    ).toBeNull()
  })

  it('emits exact external frame ancestors from server-owned venue policy', () => {
    const revision = 'a'.repeat(40)
    const headers = getEmbedResponseHeaders(new NextRequest('https://guide.example/embed/museum'), {
      RAILWAY_ENVIRONMENT: 'staging',
      RAILWAY_GIT_COMMIT_SHA: revision,
      EMBED_PREVIEW_ENABLED: 'true',
      WIDGET_PREVIEW_ORIGINS_JSON: JSON.stringify({
        museum: ['https://museum.example'],
      }),
    })

    expect(headers?.get('Content-Security-Policy')).toBe(
      "frame-ancestors 'self' https://museum.example",
    )
    expect(headers?.get('Cache-Control')).toBe('private, no-store')
    expect(headers?.get('Referrer-Policy')).toBe('no-referrer')
    expect(headers?.get('X-PathFinder-Revision')).toBe(revision)
    expect(headers?.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers?.get('X-Robots-Tag')).toBe('noindex, nofollow')
    expect(headers?.has('Access-Control-Allow-Origin')).toBe(false)
    expect(headers?.has('Vary')).toBe(false)
  })

  it('applies the complete header set through the Clerk-wrapped handler seam', async () => {
    const originalFlag = process.env.EMBED_PREVIEW_ENABLED
    const originalPolicy = process.env.WIDGET_PREVIEW_ORIGINS_JSON
    process.env.EMBED_PREVIEW_ENABLED = 'false'
    delete process.env.WIDGET_PREVIEW_ORIGINS_JSON

    try {
      const handler = middleware as unknown as (
        auth: unknown,
        request: NextRequest,
      ) => Response | undefined | Promise<Response | undefined>
      const response = await handler(
        undefined,
        new NextRequest('https://guide.example/embed/museum'),
      )

      expect(response?.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
      expect(response?.headers.get('Cache-Control')).toBe('private, no-store')
      expect(response?.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(response?.headers.get('X-PathFinder-Revision')).toBe(
        process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown',
      )
      expect(response?.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(response?.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    } finally {
      if (originalFlag === undefined) delete process.env.EMBED_PREVIEW_ENABLED
      else process.env.EMBED_PREVIEW_ENABLED = originalFlag
      if (originalPolicy === undefined) delete process.env.WIDGET_PREVIEW_ORIGINS_JSON
      else process.env.WIDGET_PREVIEW_ORIGINS_JSON = originalPolicy
    }
  })

  it('renders wildcard policy input as self-only at the response boundary', () => {
    const headers = getEmbedResponseHeaders(new NextRequest('https://guide.example/embed/museum'), {
      RAILWAY_ENVIRONMENT: 'staging',
      EMBED_PREVIEW_ENABLED: 'true',
      WIDGET_PREVIEW_ORIGINS_JSON: JSON.stringify({
        museum: ['https://*.example.com'],
      }),
    })

    expect(headers?.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
  })

  it.each([
    '/embed',
    '/embed/',
    '/embed/unknown',
    '/embed/museum/extra',
    '/embed/museum%2Fextra',
    '/embed/museum.html',
    `/embed/${'a'.repeat(201)}`,
  ])('keeps invalid or unmatched embed path self-only: %s', (pathname) => {
    const headers = getEmbedResponseHeaders(new NextRequest(`https://guide.example${pathname}`), {
      RAILWAY_ENVIRONMENT: 'staging',
      EMBED_PREVIEW_ENABLED: 'true',
      WIDGET_PREVIEW_ORIGINS_JSON: JSON.stringify({
        museum: ['https://museum.example'],
      }),
    })

    expect(headers?.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
  })

  it.each(['?chrome=hidden', '?source=widget', '?chrome=hidden&source=widget'])(
    'keeps every query-bearing embed self-only: %s',
    (query) => {
      const headers = getEmbedResponseHeaders(
        new NextRequest(`https://guide.example/embed/museum${query}`),
        {
          RAILWAY_ENVIRONMENT: 'staging',
          EMBED_PREVIEW_ENABLED: 'true',
          WIDGET_PREVIEW_ORIGINS_JSON: JSON.stringify({
            museum: ['https://museum.example'],
          }),
        },
      )

      expect(headers?.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
    },
  )
})
