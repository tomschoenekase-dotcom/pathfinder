import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  flag: vi.fn(),
  overview: vi.fn(),
  checkout: vi.fn(),
  portal: vi.fn(),
  cancellation: vi.fn(),
  addOnInterest: vi.fn(),
  parseEnv: vi.fn(),
}))

vi.mock('@pathfinder/billing', () => ({
  BillingServiceError: class BillingServiceError extends Error {},
  parseBillingEnvironment: mocks.parseEnv,
  createStripeClient: () => ({}),
  StripeBillingProvider: class {},
  getTenantBillingOverview: mocks.overview,
  createTenantCheckout: mocks.checkout,
  createTenantPortal: mocks.portal,
  requestTenantCancellation: mocks.cancellation,
  recordTenantAddOnInterest: mocks.addOnInterest,
  BILLING_ADD_ON_CATALOG: [],
}))

import { router } from '../core'
import type { TRPCContext } from '../context'
import { billingRouter } from './billing'

const testRouter = router({ billing: billingRouter })
function context(role: 'OWNER' | 'MANAGER' | 'STAFF' = 'OWNER'): TRPCContext {
  return {
    db: { tenantFeatureFlag: { findUnique: mocks.flag } } as unknown as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'user-a', activeTenantId: 'tenant-a', role, isPlatformAdmin: false },
  }
}

describe('billing tenant API boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.parseEnv.mockReturnValue({ STRIPE_MODE: 'test' })
    mocks.flag.mockResolvedValue({ enabled: true })
    mocks.overview.mockResolvedValue({ enabled: true, account: null })
    mocks.checkout.mockResolvedValue({ url: 'https://checkout.test/session' })
    mocks.portal.mockResolvedValue({ url: 'https://portal.test/session' })
    mocks.cancellation.mockResolvedValue({ awaitingWebhook: true })
    mocks.addOnInterest.mockResolvedValue({ request: { id: 'request-a' } })
  })

  it('hides billing before the tenant pilot flag is enabled', async () => {
    mocks.flag.mockResolvedValue(null)
    await expect(testRouter.createCaller(context()).billing.overview()).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(mocks.flag).toHaveBeenCalledWith({
      where: {
        tenantId_flagKey: { tenantId: 'tenant-a', flagKey: 'billing-ui-v1' },
      },
      select: { enabled: true },
    })
    expect(mocks.overview).not.toHaveBeenCalled()
  })

  it('rejects non-owner Checkout creation', async () => {
    await expect(
      testRouter.createCaller(context('STAFF')).billing.createCheckout({
        planKey: 'torchiko_pilot_test',
        venueIds: ['venue-a'],
      }),
    ).rejects.toBeTruthy()
    expect(mocks.checkout).not.toHaveBeenCalled()
  })

  it('rejects browser-supplied tenant, customer, and provider price fields', async () => {
    await expect(
      testRouter.createCaller(context()).billing.createCheckout({
        planKey: 'torchiko_pilot_test',
        venueIds: ['venue-a'],
        tenantId: 'tenant-b',
        customerId: 'cus_attacker',
        priceId: 'price_attacker',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.checkout).not.toHaveBeenCalled()
  })

  it('derives Checkout and Portal ownership from the authenticated tenant', async () => {
    const caller = testRouter.createCaller(context())
    await caller.billing.createCheckout({ planKey: 'torchiko_pilot_test', venueIds: ['venue-a'] })
    await caller.billing.createPortal()
    expect(mocks.checkout).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', actorId: 'user-a' }),
    )
    expect(mocks.portal).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }))
  })

  it('returns only a sanitized client projection and exposes an unexpired Checkout URL to owners', async () => {
    mocks.overview.mockResolvedValue({
      enabled: true,
      capabilities: { checkout: true, portal: true, cancellation: true },
      catalog: [],
      venues: [],
      access: null,
      account: {
        billingMode: 'STRIPE_SUBSCRIPTION',
        currency: 'usd',
        status: 'PENDING',
        paidThroughAt: null,
        gracePeriodEndsAt: null,
        reconciliationHealth: 'CURRENT',
        lastReconciledAt: null,
        stripeCustomerId: 'cus_private',
        internalNotes: 'private note',
        commercialAgreements: [],
        invoiceProjections: [],
        customerRequests: [],
        checkoutAttempts: [
          {
            stripeCheckoutUrl: 'https://checkout.stripe.test/session',
            expiresAt: new Date(Date.now() + 60_000),
          },
        ],
        eventApplications: [{ transition: { secret: true } }],
        reconciliationRuns: [],
        accessOverrides: [],
      },
    })
    const owner = await testRouter.createCaller(context('OWNER')).billing.overview()
    expect(owner.currentCheckoutUrl).toBe('https://checkout.stripe.test/session')
    expect(owner.hasStripeCustomer).toBe(true)
    expect(JSON.stringify(owner)).not.toContain('cus_private')
    expect(JSON.stringify(owner)).not.toContain('private note')
    expect(JSON.stringify(owner)).not.toContain('secret')

    const staff = await testRouter.createCaller(context('STAFF')).billing.overview()
    expect(staff.currentCheckoutUrl).toBeNull()
  })

  it('derives cancellation and add-on ownership from the session and rejects injected tenant fields', async () => {
    const caller = testRouter.createCaller(context())
    await caller.billing.requestCancellation({
      operationId: '22222222-2222-4222-8222-222222222222',
      reason: 'No longer required',
    })
    await caller.billing.recordAddOnInterest({
      operationId: '33333333-3333-4333-8333-333333333333',
      featureKey: 'premium-voice',
    })
    expect(mocks.cancellation).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', actorId: 'user-a' }),
    )
    expect(mocks.addOnInterest).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', actorId: 'user-a' }),
    )
    await expect(
      caller.billing.requestCancellation({
        operationId: '44444444-4444-4444-8444-444444444444',
        reason: 'No longer required',
        tenantId: 'tenant-b',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  describe('clientState', () => {
    const readyOverview = {
      enabled: true,
      capabilities: { checkout: false, portal: false, cancellation: false },
      catalog: [],
      access: null,
      account: null,
    }

    it('forbids STAFF before any billing read', async () => {
      await expect(
        testRouter.createCaller(context('STAFF')).billing.clientState(),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(mocks.flag).not.toHaveBeenCalled()
      expect(mocks.overview).not.toHaveBeenCalled()
    })

    it('reads only the authenticated tenant for a manager', async () => {
      mocks.overview.mockResolvedValue(readyOverview)
      const result = await testRouter.createCaller(context('MANAGER')).billing.clientState()
      expect(result).toMatchObject({ state: 'no_setup', reason: 'no_billing_account' })
      expect(mocks.overview).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }))
      expect(mocks.flag).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId_flagKey: { tenantId: 'tenant-a', flagKey: 'billing-ui-v1' } },
        }),
      )
    })

    it('ignores browser-supplied tenant input and uses the session tenant', async () => {
      mocks.overview.mockResolvedValue(readyOverview)
      await testRouter
        .createCaller(context())
        .billing.clientState({ tenantId: 'tenant-b' } as never)
      expect(mocks.overview).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }))
      expect(mocks.flag).toHaveBeenCalledTimes(1)
      expect(mocks.flag.mock.calls[0]?.[0].where.tenantId_flagKey.tenantId).toBe('tenant-a')
    })

    it('reports no setup, not an error, when the tenant pilot flag is off', async () => {
      mocks.flag.mockResolvedValue(null)
      mocks.overview.mockResolvedValue(readyOverview)
      const result = await testRouter.createCaller(context()).billing.clientState()
      expect(result).toMatchObject({ state: 'no_setup', reason: 'billing_not_enabled' })
    })

    it('returns an explicit configuration error instead of a payment state', async () => {
      mocks.parseEnv.mockImplementation(() => {
        throw new Error('invalid environment')
      })
      const result = await testRouter.createCaller(context()).billing.clientState()
      expect(result).toMatchObject({
        state: 'error',
        errorKind: 'configuration',
        nextAction: 'retry',
        plan: null,
        amountDue: null,
      })
      expect(mocks.overview).not.toHaveBeenCalled()
    })

    it('returns an explicit retrieval error when the read fails', async () => {
      mocks.overview.mockRejectedValue(new Error('database unavailable'))
      const result = await testRouter.createCaller(context()).billing.clientState()
      expect(result).toMatchObject({ state: 'error', errorKind: 'retrieval', plan: null })
    })
  })
})
