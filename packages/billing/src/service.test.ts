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
      stripeCheckoutUrl: 'https://checkout.stripe.test/existing',
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
      url: 'https://checkout.stripe.test/existing',
      replayed: true,
    })
    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', operationKey: 'operation-a' },
    })
  })

  it('lets Prisma inherit tenant scope for nested covered-venue creation', async () => {
    const providerError = new Error('stop before provider work')
    const commercialAgreementCreate = vi.fn().mockResolvedValue({
      id: 'agreement-a',
      internalPlanKey: 'torchiko_pilot_test',
    })
    const tx = {
      billingCheckoutAttempt: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'attempt-a' }),
      },
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-a', name: 'Tenant A' }) },
      venue: { findMany: vi.fn().mockResolvedValue([{ id: 'venue-a' }]) },
      commercialAgreement: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: commercialAgreementCreate,
      },
      billingAccount: {
        upsert: vi.fn().mockResolvedValue({
          id: 'account-a',
          stripeCustomerId: null,
          billingEmail: null,
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-a' }) },
    }
    const client = {
      $transaction: async (callback: (value: typeof tx) => unknown) => callback(tx),
    }

    await expect(
      createTenantCheckout({
        tenantId: 'tenant-a',
        actorId: 'admin-a',
        actorRole: 'PLATFORM_ADMIN',
        planKey: 'torchiko_pilot_test',
        venueIds: ['venue-a'],
        negotiatedTerms: {
          amountMinor: 2500n,
          currency: 'usd',
          interval: 'month',
          intervalCount: 1,
          reason: 'Approved sandbox lifecycle test',
          reference: 'SANDBOX-QA',
        },
        provider: { createCustomer: vi.fn().mockRejectedValue(providerError) } as never,
        client: client as never,
        environment: checkoutEnvironment,
      }),
    ).rejects.toBe(providerError)
    const nestedCreate = commercialAgreementCreate.mock.calls[0]?.[0]?.data?.coveredVenues?.create
    expect(nestedCreate).toEqual([{ venueId: 'venue-a', createdBy: 'admin-a' }])
  })

  it('reuses a valid matching Checkout Session instead of creating a duplicate', async () => {
    const existingAttempt = {
      id: 'attempt-existing',
      stripeCheckoutSessionId: 'cs_test_existing',
      stripeCheckoutUrl: 'https://checkout.stripe.test/existing',
    }
    const tx = {
      billingCheckoutAttempt: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(existingAttempt),
        create: vi.fn(),
      },
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-a', name: 'Tenant A' }) },
      venue: { findMany: vi.fn().mockResolvedValue([{ id: 'venue-a' }]) },
      commercialAgreement: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'agreement-a',
          status: 'PENDING',
          billingMode: 'STRIPE_SUBSCRIPTION',
          stripeSubscriptionId: null,
          internalPlanKey: 'torchiko_pilot_test',
          internalPlanVersion: 1,
          coveredVenueCount: 1,
          quantity: 1,
          agreedAmountMinor: 2500n,
          currency: 'usd',
          billingInterval: 'MONTH',
          billingIntervalCount: 1,
          stripePriceId: null,
        }),
      },
      commercialAgreementVenue: { count: vi.fn().mockResolvedValue(1) },
      billingAccount: { findUnique: vi.fn().mockResolvedValue({ id: 'account-a' }) },
    }
    const client = {
      $transaction: async (callback: (value: typeof tx) => unknown) => callback(tx),
    }
    const provider = { createCheckoutSession: vi.fn(), createCustomer: vi.fn() }

    await expect(
      createTenantCheckout({
        tenantId: 'tenant-a',
        actorId: 'admin-a',
        actorRole: 'PLATFORM_ADMIN',
        planKey: 'torchiko_pilot_test',
        venueIds: ['venue-a'],
        negotiatedTerms: {
          amountMinor: 2500n,
          currency: 'usd',
          interval: 'month',
          intervalCount: 1,
          reason: 'Approved sandbox lifecycle test',
          reference: 'SANDBOX-QA',
        },
        provider: provider as never,
        client: client as never,
        environment: checkoutEnvironment,
      }),
    ).resolves.toEqual({
      attemptId: 'attempt-existing',
      sessionId: 'cs_test_existing',
      url: 'https://checkout.stripe.test/existing',
      replayed: true,
    })
    expect(tx.billingCheckoutAttempt.create).not.toHaveBeenCalled()
    expect(provider.createCustomer).not.toHaveBeenCalled()
    expect(provider.createCheckoutSession).not.toHaveBeenCalled()
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
