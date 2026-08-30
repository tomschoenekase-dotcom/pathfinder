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

  it('rejects live mode until the exact legal identity is owner-verified', () => {
    expect(() =>
      parseBillingEnvironment({
        ...base,
        RAILWAY_ENVIRONMENT: 'production',
        STRIPE_MODE: 'live',
        STRIPE_LIVE_MODE_ALLOWED: 'true',
        STRIPE_SECRET_KEY: 'rk_live_example',
      }),
    ).toThrow(/owner-verified legal entity/u)
  })

  it('accepts a restricted live key only with the owner-verified legal identity gate', () => {
    const environment = parseBillingEnvironment({
      ...base,
      RAILWAY_ENVIRONMENT: 'production',
      STRIPE_MODE: 'live',
      STRIPE_LIVE_MODE_ALLOWED: 'true',
      STRIPE_SECRET_KEY: 'rk_live_example',
      TORCHIKO_LEGAL_ENTITY_VERIFIED: 'true',
      TORCHIKO_LEGAL_ENTITY_NAME: 'Verified legal party from owner records',
    })
    expect(environment.STRIPE_MODE).toBe('live')
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
