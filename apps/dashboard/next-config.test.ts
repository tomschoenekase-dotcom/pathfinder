import { describe, expect, it } from 'vitest'

import nextConfig from './next.config'

describe('development origin boundary', () => {
  it('admits only the numeric loopback used by browser verification', () => {
    expect(nextConfig.allowedDevOrigins).toEqual(['127.0.0.1'])
  })
})

describe('standalone runtime tracing', () => {
  it('retains the parser used by the externalized observability transformer', () => {
    expect(nextConfig.outputFileTracingIncludes?.['/**']).toContain(
      '../../node_modules/.pnpm/meriyah@*/node_modules/meriyah/**/*',
    )
  })
})

describe('response security baseline', () => {
  it('applies transport and content-type protection to every route', async () => {
    expect(nextConfig.headers).toBeTypeOf('function')
    const rules = await nextConfig.headers!()
    expect(rules).toEqual([
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
      ...['/oauth/:path*', '/approve/:path*'].map((source) => ({
        source,
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      })),
    ])
  })

  it('never lets operator consent or approval pages be framed', async () => {
    const rules = await nextConfig.headers!()
    for (const source of ['/oauth/:path*', '/approve/:path*']) {
      const rule = rules.find((candidate) => candidate.source === source)
      expect(rule?.headers).toContainEqual({ key: 'X-Frame-Options', value: 'DENY' })
    }
  })
})
