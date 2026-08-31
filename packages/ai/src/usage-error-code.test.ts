import { describe, expect, it } from 'vitest'

import { normalizeAiUsageErrorCode } from './usage-error-code'

describe('normalizeAiUsageErrorCode', () => {
  it('preserves product-owned provider codes and bounded HTTP status codes', () => {
    expect(normalizeAiUsageErrorCode('provider-connection-timeout')).toBe(
      'provider-connection-timeout',
    )
    expect(normalizeAiUsageErrorCode('provider-http-503')).toBe('provider-http-503')
    expect(normalizeAiUsageErrorCode(undefined)).toBeUndefined()
  })

  it('collapses arbitrary or malformed values without reflecting them', () => {
    expect(normalizeAiUsageErrorCode('UPSTREAM_SECRET_TOKEN')).toBe('provider-error')
    expect(normalizeAiUsageErrorCode('provider-http-999')).toBe('provider-error')
  })
})
