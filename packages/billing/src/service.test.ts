import { describe, expect, it, vi } from 'vitest'

import { createTenantCheckout, isNewerProviderState } from './service'

const checkoutEnvironment = {
  NODE_ENV: 'test' as const,
  RAILWAY_ENVIRONMENT: 'staging' as const,
  DASHBOARD_URL: 'https://dashboard.test',
  STRIPE_MODE: 'test' as const,
  STRIPE_ACCOUNT_NAMESPACE: 'torchiko-test',
  STRIPE_SECRET_KEY: 'sk_test_fixture',
  STRIPE_CHECKOUT_ENABLED: true,
  STRIPE_BILLING_UI_ENABLED: false,
  STRIPE_CUSTOMER_PORTAL_ENABLED: false,
  STRIPE_CANCELLATION_ENABLED: false,
  STRIPE_WEBHOOK_PROCESSING_ENABLED: false,
  STRIPE_RECONCILIATION_ENABLED: false,
  BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED: false,
  STRIPE_LIVE_MODE_ALLOWED: false,
  BILLING_GRACE_PERIOD_DAYS: 14,
  STRIPE_CATALOG_JSON: JSON.stringify({
    catalogVersion: 1,
    plans: [
      {
        key: 'torchiko_pilot_test',
        version: 1,
        displayName: 'Pilot test',
        description: 'Sandbox fixture',
        providerMode: 'test',
        stripeProductId: 'prod_test',
        stripePriceId: 'price_test',
        currency: 'usd',
        interval: 'month',
        unitAmount: 1500,
        minimumVenueCount: 1,
        maximumVenueCount: null,
        newSalesEnabled: true,
        portalChangesEnabled: false,
      },
    ],
  }),
}

describe('provider event ordering fence', () => {
  it('accepts the first event and rejects older state', () => {
    expect(
      isNewerProviderState({
        incomingAt: new Date(2),
        incomingEventId: 'evt_2',
        appliedAt: null,
        appliedEventId: null,
      }),
    ).toBe(true)
    expect(
      isNewerProviderState({
        incomingAt: new Date(1),
        incomingEventId: 'evt_1',
        appliedAt: new Date(2),
        appliedEventId: 'evt_2',
      }),
    ).toBe(false)
  })

  it('uses the event id as a deterministic same-time tie breaker', () => {
    expect(
      isNewerProviderState({
        incomingAt: new Date(2),
        incomingEventId: 'evt_b',
        appliedAt: new Date(2),
        appliedEventId: 'evt_a',
      }),
    ).toBe(true)
    expect(
      isNewerProviderState({
        incomingAt: new Date(2),
        incomingEventId: 'evt_a',
        appliedAt: new Date(2),
        appliedEventId: 'evt_b',
      }),
    ).toBe(false)
  })
})

describe('negotiated Checkout boundary', () => {
  it('scopes idempotent Checkout replay lookup by tenant for isolation middleware', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'attempt-a',
      stripeCheckoutSessionId: 'cs_test_existing',
    })
    const client = {
      $transaction: async (callback: (tx: unknown) => unknown) =>
        callback({ billingCheckoutAttempt: { findFirst } }),
    }

    await expect(
      createTenantCheckout({
        tenantId: 'tenant-a',
        actorId: 'admin-a',
        actorRole: 'PLATFORM_ADMIN',
        planKey: 'torchiko_pilot_test',
        venueIds: ['venue-a'],
        operationKey: 'operation-a',
        provider: {} as never,
        client: client as never,
        environment: checkoutEnvironment,
      }),
    ).resolves.toEqual({
      attemptId: 'attempt-a',
      sessionId: 'cs_test_existing',
      url: null,
      replayed: true,
    })
    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', operationKey: 'operation-a' },
    })
  })

  it('rejects negotiated pricing outside the platform-admin boundary before touching storage', async () => {
    await expect(
      createTenantCheckout({
        tenantId: 'tenant-a',
        actorId: 'user-a',
        actorRole: 'OWNER',
        planKey: 'torchiko_pilot_test',
        venueIds: ['venue-a'],
        negotiatedTerms: {
          amountMinor: 3750n,
          currency: 'usd',
          interval: 'month',
          intervalCount: 1,
          reason: 'Approved quote',
          reference: 'QUOTE-42',
        },
        provider: {} as never,
        client: {} as never,
        environment: checkoutEnvironment,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects zero or unbounded negotiated amounts before touching storage', async () => {
    await expect(
      createTenantCheckout({
        tenantId: 'tenant-a',
        actorId: 'admin-a',
        actorRole: 'PLATFORM_ADMIN',
        planKey: 'torchiko_pilot_test',
        venueIds: ['venue-a'],
        negotiatedTerms: {
          amountMinor: 0n,
          currency: 'usd',
          interval: 'month',
          intervalCount: 1,
          reason: 'Invalid quote fixture',
          reference: 'QUOTE-INVALID',
        },
        provider: {} as never,
        client: {} as never,
        environment: checkoutEnvironment,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
