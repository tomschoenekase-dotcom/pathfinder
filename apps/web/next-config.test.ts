import { describe, expect, it } from 'vitest'

import nextConfig from './next.config'

describe('standalone runtime tracing', () => {
  it('retains the parser used by the externalized observability transformer', () => {
    expect(nextConfig.outputFileTracingIncludes?.['/**']).toContain(
      '../../node_modules/.pnpm/meriyah@*/node_modules/meriyah/**/*',
    )
  })
})

describe('embed response headers', () => {
  it('leaves dynamic framing to middleware while retaining crawler denial', async () => {
    expect(nextConfig.headers).toBeTypeOf('function')
    const rules = await nextConfig.headers!()
    const embedRule = rules.find((rule) => rule.source === '/embed/:path*')

    expect(embedRule?.headers).toEqual([{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }])
  })

  it('serves the classic loader as revalidating JavaScript', async () => {
    expect(nextConfig.headers).toBeTypeOf('function')
    const rules = await nextConfig.headers!()

    expect(rules.find((rule) => rule.source === '/widget.js')?.headers).toEqual([
      { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
      { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
    ])
  })

  it('serves the cross-origin widget stylesheet as revalidating CSS', async () => {
    expect(nextConfig.headers).toBeTypeOf('function')
    const rules = await nextConfig.headers!()

    expect(rules.find((rule) => rule.source === '/widget.css')?.headers).toEqual([
      { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
      { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
    ])
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
