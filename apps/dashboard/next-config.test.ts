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
