import { describe, expect, it } from 'vitest'

import nextConfig from './next.config'

describe('embed response headers', () => {
  it('pins same-origin framing and crawler denial for every embed path', async () => {
    expect(nextConfig.headers).toBeTypeOf('function')
    const rules = await nextConfig.headers!()
    const embedRule = rules.find((rule) => rule.source === '/embed/:path*')

    expect(embedRule?.headers).toEqual(
      expect.arrayContaining([
        { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      ]),
    )
  })
})

describe('offline asset response headers', () => {
  it('forces worker updates and permits only the intended root scope', async () => {
    expect(nextConfig.headers).toBeTypeOf('function')
    const rules = await nextConfig.headers!()

    expect(rules.find((rule) => rule.source === '/sw.js')?.headers).toEqual(
      expect.arrayContaining([
        { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
        { key: 'Service-Worker-Allowed', value: '/' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
      ]),
    )
    expect(rules.find((rule) => rule.source === '/offline.html')?.headers).toEqual(
      expect.arrayContaining([
        { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
        {
          key: 'Content-Security-Policy',
          value:
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      ]),
    )
  })
})
