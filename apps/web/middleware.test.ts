import { NextRequest } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: vi.fn((handler: unknown) => handler),
}))

import middleware, { config, getEmbedResponseHeaders, getPageResponseHeaders } from './middleware'

describe('middleware response boundaries', () => {
  it('keeps ordinary pages self-framed and omits embed-only headers', () => {
    const headers = getPageResponseHeaders(new NextRequest('https://guide.example/museum'))
    expect(headers?.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
    expect(headers?.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(headers?.has('Cache-Control')).toBe(false)
  })

  it('lets only the configured client portal frame the data-free appearance preview', () => {
    const portal = { DASHBOARD_URL: 'https://app.staging.torchiko.com', NODE_ENV: 'production' }
    const preview = getPageResponseHeaders(
      new NextRequest('https://guide.example/appearance-preview?embed=1'),
      portal,
    )
    expect(preview?.get('Content-Security-Policy')).toBe(
      "frame-ancestors 'self' https://app.staging.torchiko.com",
    )
    expect(preview?.has('X-Frame-Options')).toBe(false)
    expect(preview?.get('Permissions-Policy')).toContain('microphone=()')
    expect(preview?.get('X-Robots-Tag')).toBe('noindex, nofollow')

    // Every other page, including the real visitor chat, stays self-framed.
    for (const path of ['/museum/chat', '/appearance-preview-other', '/app/museum']) {
      const headers = getPageResponseHeaders(
        new NextRequest(`https://guide.example${path}`),
        portal,
      )
      expect(headers?.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
      expect(headers?.get('X-Frame-Options')).toBe('SAMEORIGIN')
    }
    // Without a configured portal origin, the preview is self-framed too.
    const unconfigured = getPageResponseHeaders(
      new NextRequest('https://guide.example/appearance-preview'),
      { NODE_ENV: 'production' },
    )
    expect(unconfigured?.get('X-Frame-Options')).toBe('SAMEORIGIN')
  })

  it('gives canonical and alias app URLs the same voice and privacy policy', () => {
    const canonical = getPageResponseHeaders(new NextRequest('https://guide.example/app/museum'))
    const compact = getPageResponseHeaders(
      new NextRequest('https://guide.example/app/museum?header=compact'),
    )
    const alias = getEmbedResponseHeaders(
      new NextRequest('https://guide.example/embed/museum?chrome=hidden'),
    )
    for (const name of [
      'Permissions-Policy',
      'Content-Security-Policy',
      'Referrer-Policy',
      'X-Robots-Tag',
    ]) {
      expect(canonical?.get(name)).toBe(compact?.get(name))
      expect(canonical?.get(name)).toBe(alias?.get(name))
    }
    expect(canonical?.get('Permissions-Policy')).toContain('microphone=(self)')
    expect(canonical?.get('X-Frame-Options')).toBe('SAMEORIGIN')
  })

  it('adds exact resolver-owned origins only for canonical queryless embed paths', () => {
    const request = new NextRequest('https://guide.example/embed/museum')
    expect(
      getEmbedResponseHeaders(request, ['https://museum.example'])?.get('Content-Security-Policy'),
    ).toBe("frame-ancestors 'self' https://museum.example")
    expect(
      getEmbedResponseHeaders(new NextRequest('https://guide.example/embed/museum/inline'), [
        'https://museum.example',
      ])?.get('Content-Security-Policy'),
    ).toBe("frame-ancestors 'self' https://museum.example")
    expect(
      getEmbedResponseHeaders(new NextRequest(`${request.url}?chrome=hidden`), [
        'https://museum.example',
      ])?.get('Content-Security-Policy'),
    ).toBe("frame-ancestors 'self'")
    expect(
      getEmbedResponseHeaders(new NextRequest('https://guide.example/embed/museum/extra'), [
        'https://museum.example',
      ])?.get('Content-Security-Policy'),
    ).toBe("frame-ancestors 'self'")
  })

  it('uses self-only policy on resolver timeout, failure, or invalid payload', async () => {
    const originalFetch = globalThis.fetch
    const originalToken = process.env.INTERNAL_POLICY_TOKEN
    const originalOrigin = process.env.INTERNAL_WEB_ORIGIN
    const handler = middleware as unknown as (
      auth: unknown,
      request: NextRequest,
    ) => Promise<Response | undefined>
    try {
      process.env.INTERNAL_POLICY_TOKEN = 'test-internal-policy-token-with-more-than-32-bytes'
      process.env.INTERNAL_WEB_ORIGIN = 'http://127.0.0.1:3100'
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout')) as typeof fetch
      let response = await handler(undefined, new NextRequest('https://guide.example/embed/museum'))
      expect(response?.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")

      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ origins: ['https://x.example/path'] })),
        ) as typeof fetch
      response = await handler(undefined, new NextRequest('https://guide.example/embed/museum'))
      expect(response?.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
    } finally {
      globalThis.fetch = originalFetch
      if (originalToken === undefined) delete process.env.INTERNAL_POLICY_TOKEN
      else process.env.INTERNAL_POLICY_TOKEN = originalToken
      if (originalOrigin === undefined) delete process.env.INTERNAL_WEB_ORIGIN
      else process.env.INTERNAL_WEB_ORIGIN = originalOrigin
    }
  })

  it('fetches policy from the internal origin with the shared token and one-second timeout', async () => {
    const originalPublicOrigin = process.env.NEXT_PUBLIC_WEB_URL
    const originalInternalOrigin = process.env.INTERNAL_WEB_ORIGIN
    const originalToken = process.env.INTERNAL_POLICY_TOKEN
    const originalFetch = globalThis.fetch
    process.env.NEXT_PUBLIC_WEB_URL = 'https://other-deployment.example'
    process.env.INTERNAL_WEB_ORIGIN = 'https://web-internal.example/'
    process.env.INTERNAL_POLICY_TOKEN = 'test-internal-policy-token-with-more-than-32-bytes'
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ origins: ['https://museum.example'] })))
    globalThis.fetch = fetch as typeof globalThis.fetch
    try {
      const handler = middleware as unknown as (
        auth: unknown,
        request: NextRequest,
      ) => Promise<Response | undefined>
      const response = await handler(
        undefined,
        new NextRequest('https://untrusted-header.example/embed/museum'),
      )
      expect(fetch).toHaveBeenCalledTimes(1)
      const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(url.toString()).toBe(
        'https://web-internal.example/api/internal/embed-frame-policy/museum',
      )
      expect(options.cache).toBe('no-store')
      expect(options.signal).toBeInstanceOf(AbortSignal)
      expect(options.headers).toEqual({
        'x-torchiko-internal-policy-token': process.env.INTERNAL_POLICY_TOKEN,
      })
      expect(response?.headers.get('Content-Security-Policy')).toBe(
        "frame-ancestors 'self' https://museum.example",
      )
    } finally {
      globalThis.fetch = originalFetch
      if (originalPublicOrigin === undefined) delete process.env.NEXT_PUBLIC_WEB_URL
      else process.env.NEXT_PUBLIC_WEB_URL = originalPublicOrigin
      if (originalInternalOrigin === undefined) delete process.env.INTERNAL_WEB_ORIGIN
      else process.env.INTERNAL_WEB_ORIGIN = originalInternalOrigin
      if (originalToken === undefined) delete process.env.INTERNAL_POLICY_TOKEN
      else process.env.INTERNAL_POLICY_TOKEN = originalToken
    }
  })

  it('uses loopback by default and stays self-only when the token is unset', async () => {
    const originalToken = process.env.INTERNAL_POLICY_TOKEN
    const originalOrigin = process.env.INTERNAL_WEB_ORIGIN
    const originalPort = process.env.PORT
    const originalFetch = globalThis.fetch
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ origins: ['https://museum.example'] })))
    globalThis.fetch = fetch as typeof globalThis.fetch
    delete process.env.INTERNAL_POLICY_TOKEN
    delete process.env.INTERNAL_WEB_ORIGIN
    process.env.PORT = '3410'
    try {
      const handler = middleware as unknown as (
        auth: unknown,
        request: NextRequest,
      ) => Promise<Response | undefined>
      const denied = await handler(undefined, new NextRequest('https://guide.example/embed/museum'))
      expect(fetch).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(denied?.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
      process.env.INTERNAL_POLICY_TOKEN = 'test-internal-policy-token-with-more-than-32-bytes'
      const admitted = await handler(
        undefined,
        new NextRequest('https://guide.example/embed/museum'),
      )
      const [url] = fetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(url.toString()).toBe('http://127.0.0.1:3410/api/internal/embed-frame-policy/museum')
      expect(admitted?.headers.get('Content-Security-Policy')).toBe(
        "frame-ancestors 'self' https://museum.example",
      )
    } finally {
      globalThis.fetch = originalFetch
      warn.mockRestore()
      if (originalToken === undefined) delete process.env.INTERNAL_POLICY_TOKEN
      else process.env.INTERNAL_POLICY_TOKEN = originalToken
      if (originalOrigin === undefined) delete process.env.INTERNAL_WEB_ORIGIN
      else process.env.INTERNAL_WEB_ORIGIN = originalOrigin
      if (originalPort === undefined) delete process.env.PORT
      else process.env.PORT = originalPort
    }
  })

  it('does not recurse through the internal Node policy route', async () => {
    const originalFetch = globalThis.fetch
    const fetch = vi.fn()
    globalThis.fetch = fetch as typeof globalThis.fetch
    try {
      const handler = middleware as unknown as (
        auth: unknown,
        request: NextRequest,
      ) => Promise<Response | undefined>
      const response = await handler(
        undefined,
        new NextRequest('https://guide.example/api/internal/embed-frame-policy/museum'),
      )
      expect(fetch).not.toHaveBeenCalled()
      expect(response).toBeDefined()
      expect(
        unstable_doesMiddlewareMatch({
          config,
          url: 'https://guide.example/api/internal/embed-frame-policy/museum',
        }),
      ).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
