import { describe, expect, it } from 'vitest'

import { billingCapabilityEnabled, parseBillingEnvironment } from './config'

const base = {
  NODE_ENV: 'test',
  RAILWAY_ENVIRONMENT: 'staging',
  DASHBOARD_URL: 'https://app.staging.torchiko.com',
}

describe('billing environment', () => {
  it('fails closed by default', () => {
    const environment = parseBillingEnvironment(base)
    expect(environment.STRIPE_MODE).toBe('test')
    expect(billingCapabilityEnabled('ui', environment)).toBe(false)
    expect(billingCapabilityEnabled('checkout', environment)).toBe(false)
    expect(billingCapabilityEnabled('webhook', environment)).toBe(false)
  })

  it('rejects a live key in test mode', () => {
    expect(() => parseBillingEnvironment({ ...base, STRIPE_SECRET_KEY: 'sk_live_wrong' })).toThrow(
      /sk_test_/u,
    )
  })

  it('rejects live mode outside production even when the flag is true', () => {
    expect(() =>
      parseBillingEnvironment({
        ...base,
        STRIPE_MODE: 'live',
        STRIPE_LIVE_MODE_ALLOWED: 'true',
        STRIPE_SECRET_KEY: 'sk_live_example',
      }),
    ).toThrow(/forbidden outside/u)
  })

  it('requires all portal prerequisites', () => {
    const environment = parseBillingEnvironment({
      ...base,
      STRIPE_SECRET_KEY: 'sk_test_example',
      STRIPE_CUSTOMER_PORTAL_ENABLED: 'true',
    })
    expect(billingCapabilityEnabled('portal', environment)).toBe(false)
  })
})
