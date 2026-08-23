import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }))

vi.mock('@pathfinder/db', () => ({
  db: { billingAccount: { findMany: mocks.findMany } },
  withTenantIsolationBypass: <T>(action: () => T) => action(),
}))

vi.mock('@pathfinder/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/billing')>()
  return {
    ...actual,
    BillingServiceError: class BillingServiceError extends Error {},
    StripeBillingProvider: class StripeBillingProvider {},
    createStripeClient: vi.fn(),
    parseBillingEnvironment: vi.fn(),
    createManualBillingArrangement: vi.fn(),
    createBillingAccessOverride: vi.fn(),
    createTenantCheckout: vi.fn(),
    getTenantBillingOverview: vi.fn(),
    reconcileBillingAccount: vi.fn(),
    recordManualPayment: vi.fn(),
  }
})

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminBillingPortfolioRouter } from './billing-portfolio'

const testRouter = router({ admin: adminBillingPortfolioRouter })
const context = (): TRPCContext => ({
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: {
    userId: 'admin-1',
    activeTenantId: 'admin-scope',
    role: 'OWNER',
    isPlatformAdmin: true,
  },
})

describe('admin billing portfolio', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns bounded customer payment and CRM-link projections with attention totals', async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: 'account-1',
        tenantId: 'tenant-1',
        displayNameSnapshot: 'Museum',
        billingEmail: null,
        billingMode: 'STRIPE_SUBSCRIPTION',
        currency: 'usd',
        status: 'PAST_DUE',
        paidThroughAt: null,
        gracePeriodEndsAt: new Date('2026-08-27T00:00:00.000Z'),
        reconciliationHealth: 'DRIFT',
        lastReconciledAt: null,
        updatedAt: new Date('2026-08-20T00:00:00.000Z'),
        tenant: {
          id: 'tenant-1',
          name: 'Museum',
          status: 'ACTIVE',
          prospectCustomerRelationships: [
            {
              startedAt: new Date('2026-01-01T00:00:00.000Z'),
              organization: {
                id: 'prospect-1',
                canonicalName: 'Museum Foundation',
                relationshipTier: 'HIGH_TOUCH',
              },
            },
          ],
        },
        commercialAgreements: [
          {
            id: 'agreement-1',
            isBase: true,
            internalPlanKey: 'negotiated',
            status: 'PAST_DUE',
            billingMode: 'STRIPE_SUBSCRIPTION',
            billingInterval: 'MONTH',
            billingIntervalCount: 1,
            agreedAmountMinor: 2000n,
            currency: 'usd',
            currentPeriodEndsAt: null,
            cancelAtPeriodEnd: false,
            coveredVenueCount: 1,
          },
        ],
        invoiceProjections: [
          {
            id: 'invoice-1',
            status: 'OPEN',
            amountDueMinor: 2000n,
            amountPaidMinor: 0n,
            amountRemainingMinor: 2000n,
            currency: 'usd',
            dueAt: null,
            paidAt: null,
            failedAt: new Date('2026-08-20T00:00:00.000Z'),
            nextRetryAt: new Date('2026-08-24T00:00:00.000Z'),
            failureSummary: 'Payment failed',
          },
          ...Array.from({ length: 4 }, (_, index) => ({
            id: `paid-invoice-${index}`,
            status: 'PAID',
            amountDueMinor: 2000n,
            amountPaidMinor: 2000n,
            amountRemainingMinor: 0n,
            currency: 'usd',
            dueAt: null,
            paidAt: new Date('2026-07-20T00:00:00.000Z'),
            failedAt: null,
            nextRetryAt: null,
            failureSummary: null,
          })),
          {
            id: 'older-open-invoice',
            status: 'OPEN',
            amountDueMinor: 3000n,
            amountPaidMinor: 0n,
            amountRemainingMinor: 3000n,
            currency: 'usd',
            dueAt: new Date('2026-07-01T00:00:00.000Z'),
            paidAt: null,
            failedAt: null,
            nextRetryAt: null,
            failureSummary: 'Older outstanding balance',
          },
        ],
        customerRequests: [],
      },
    ])

    const result = await testRouter.createCaller(context()).admin.listBillingPortfolio({
      attentionOnly: true,
      limit: 25,
    })
    expect(result.summary).toEqual({ customers: 1, attention: 1, pastDue: 1, unhealthy: 1 })
    expect(result.rows[0]).toMatchObject({
      tenantId: 'tenant-1',
      needsAttention: true,
      crmOrganization: { id: 'prospect-1' },
      agreement: { agreedAmountMinor: 2000n },
      paymentRecovery: {
        state: 'PAYMENT_RECOVERY',
        reviewRequired: true,
        policy: { automaticRestrictionAuthorized: false },
        financialExposure: {
          receivableAtRiskByCurrency: [{ currency: 'usd', amountMinor: 5000n }],
        },
        relationship: { relationshipTier: 'HIGH_TOUCH' },
      },
    })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }))
    expect(mocks.findMany.mock.calls[0]![0].select.invoiceProjections).not.toHaveProperty('take')
    expect(result.rows[0]?.latestInvoices).toHaveLength(5)
    expect(result.rows[0]?.latestInvoices).not.toContainEqual(
      expect.objectContaining({ id: 'older-open-invoice' }),
    )
  })
})
