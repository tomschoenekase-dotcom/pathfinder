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
