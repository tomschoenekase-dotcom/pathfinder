import { NextRequest } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: vi.fn((handler: unknown) => handler),
}))

import middleware, { config, getEmbedResponseHeaders, getPageResponseHeaders } from './middleware'

describe('ordinary page response boundary', () => {
  it.each([
    'https://guide.example/',
    'https://guide.example/museum',
    'https://guide.example/museum/chat',
    'https://guide.example/not-found',
  ])('emits the exact privacy and clickjacking baseline: %s', (url) => {
    const headers = getPageResponseHeaders(new NextRequest(url))

    expect(Object.fromEntries(headers?.entries() ?? [])).toEqual({
      'content-security-policy': "frame-ancestors 'self'",
      'permissions-policy': 'camera=(), geolocation=(self), microphone=(), payment=(), usb=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
    })
  })

  it.each([
    'https://guide.example/embed/museum',
    'https://guide.example/api',
    'https://guide.example/api/health',
    'https://guide.example/trpc',
    'https://guide.example/trpc/chat.send',
  ])('does not overlap a separately owned response boundary: %s', (url) => {
    expect(getPageResponseHeaders(new NextRequest(url))).toBeNull()
  })

  it.each([
    'https://guide.example/_next/static/chunk.js',
    'https://guide.example/widget.js',
    'https://guide.example/widget.css',
    'https://guide.example/sw.js',
    'https://guide.example/offline.html',
  ])('leaves owned static responses outside the middleware matcher: %s', (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false)
  })

  it.each([
    'https://guide.example/api',
    'https://guide.example/api/health',
    'https://guide.example/trpc',
    'https://guide.example/trpc/chat.send',
  ])('matches API transports without adding page headers: %s', async (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true)

    const handler = middleware as unknown as (
      auth: unknown,
      request: NextRequest,
    ) => Response | undefined | Promise<Response | undefined>
    expect(await handler(undefined, new NextRequest(url))).toBeUndefined()
  })

  it('applies the baseline through the Clerk-wrapped handler seam', async () => {
    const handler = middleware as unknown as (
      auth: unknown,
      request: NextRequest,
    ) => Response | undefined | Promise<Response | undefined>
    const response = await handler(undefined, new NextRequest('https://guide.example/museum/chat'))

    expect(response?.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
    expect(response?.headers.get('Permissions-Policy')).toBe(
      'camera=(), geolocation=(self), microphone=(), payment=(), usb=()',
    )
    expect(response?.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(response?.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response?.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(response?.headers.has('Cache-Control')).toBe(false)
    expect(response?.headers.has('X-PathFinder-Revision')).toBe(false)
    expect(response?.headers.has('X-Robots-Tag')).toBe(false)
  })
})

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
    expect(headers?.has('Permissions-Policy')).toBe(false)
    expect(headers?.has('X-Frame-Options')).toBe(false)
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
