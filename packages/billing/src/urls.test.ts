import { describe, expect, it } from 'vitest'

import { configuredBillingUrl } from './urls'

describe('configuredBillingUrl', () => {
  it('builds only configured-origin paths', () => {
    expect(
      configuredBillingUrl('https://app.staging.torchiko.com', '/settings/billing?state=pending'),
    ).toBe('https://app.staging.torchiko.com/settings/billing?state=pending')
  })

  it('rejects scheme-relative and insecure remote targets', () => {
    expect(() =>
      configuredBillingUrl('https://app.staging.torchiko.com', '//evil.example'),
    ).toThrow()
    expect(() => configuredBillingUrl('http://app.torchiko.com', '/billing')).toThrow()
  })
})
