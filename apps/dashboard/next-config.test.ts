import { describe, expect, it } from 'vitest'

import nextConfig from './next.config'

describe('standalone runtime tracing', () => {
  it('retains the parser used by the externalized observability transformer', () => {
    expect(nextConfig.outputFileTracingIncludes?.['/**']).toContain(
      '../../node_modules/.pnpm/meriyah@*/node_modules/meriyah/**/*',
    )
  })
})
