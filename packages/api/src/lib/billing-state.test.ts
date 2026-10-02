import { describe, expect, it } from 'vitest'

import { clientBillingStateResponseSchema } from '../schemas/billing-state'
import {
  billingErrorState,
  deriveClientBillingState,
  type BillingOverviewInput,
} from './billing-state'

const NOW = new Date('2026-10-02T12:00:00Z')
const FUTURE = new Date('2026-11-01T00:00:00Z')

type Agreement = NonNullable<BillingOverviewInput['account']>['commercialAgreements'][number]
type Invoice = NonNullable<BillingOverviewInput['account']>['invoiceProjections'][number]

function agreement(overrides: Partial<Agreement> = {}): Agreement {
  return {
    isBase: true,
    internalPlanKey: 'torchiko_pilot',
    internalPlanVersion: 1,
    status: 'ACTIVE',
    billingMode: 'STRIPE_SUBSCRIPTION',
    billingInterval: 'MONTH',
    billingIntervalCount: 1,
    agreedAmountMinor: 1500n,
    currency: 'usd',
    stripeSubscriptionId: 'sub_1',
    cancelAtPeriodEnd: false,
    currentPeriodEndsAt: FUTURE,
    accessEndsAt: null,
    coveredVenues: [{ venue: { id: 'venue-1', name: 'Harbor' } }],
    ...overrides,
  }
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    invoiceNumber: 'T-1',
    status: 'OPEN',
    amountDueMinor: 1500n,
    amountRemainingMinor: 1500n,
    currency: 'usd',
    dueAt: FUTURE,
    paidAt: null,
    createdAt: NOW,
    invoiceDocumentUrl: null,
    hostedInvoiceUrl: 'https://invoice.example/1',
    ...overrides,
  }
}

function overview(
  options: {
    agreement?: Partial<Agreement>
    invoices?: Invoice[]
    health?: 'UNKNOWN' | 'CURRENT' | 'STALE' | 'DRIFT' | 'ERROR'
    accessState?: string
    portal?: boolean
    checkout?: boolean
    cancellation?: boolean
    customer?: string | null
    attempts?: Array<{ stripeCheckoutUrl: string | null; expiresAt: Date | null }>
    lastReconciledAt?: Date | null
    graceEndsAt?: Date | null
    events?: Array<{ status: string; providerCreatedAt: Date | null }>
  } = {},
): BillingOverviewInput {
  return {
    enabled: true,
    capabilities: {
      checkout: options.checkout ?? true,
      portal: options.portal ?? true,
      cancellation: options.cancellation ?? true,
    },
    catalog: [{ key: 'torchiko_pilot', version: 1, displayName: 'Torchiko Pilot' }],
    access: { state: options.accessState ?? 'ACTIVE' },
    account: {
      paidThroughAt: FUTURE,
      gracePeriodEndsAt: options.graceEndsAt ?? null,
      reconciliationHealth: options.health ?? 'CURRENT',
      lastReconciledAt: options.lastReconciledAt ?? null,
      stripeCustomerId: options.customer === undefined ? 'cus_1' : options.customer,
      checkoutAttempts: options.attempts ?? [],
      eventApplications: options.events ?? [],
      commercialAgreements: [agreement(options.agreement)],
      invoiceProjections: options.invoices ?? [],
    },
  }
}

function derive(input: BillingOverviewInput, role: 'OWNER' | 'MANAGER' = 'OWNER') {
  return deriveClientBillingState({ overview: input, role, now: NOW })
}

describe('deriveClientBillingState', () => {
  it('reports no setup when billing is not enabled, has no account, or no agreement', () => {
    const disabled = derive({ ...overview(), enabled: false })
    expect(disabled).toMatchObject({
      state: 'no_setup',
      reason: 'billing_not_enabled',
      nextAction: 'contact_support',
    })
    expect(derive({ ...overview(), account: null })).toMatchObject({
      state: 'no_setup',
      reason: 'no_billing_account',
    })
    const noAgreement = overview()
    noAgreement.account!.commercialAgreements = []
    expect(derive(noAgreement)).toMatchObject({ state: 'no_setup', reason: 'no_agreement' })
    // A missing account is never a payment claim.
    expect(disabled.amountDue).toBeNull()
    expect(disabled.plan).toBeNull()
  })

  it.each([
    ['COMPLIMENTARY', 'complimentary'],
    ['NO_BILLING_REQUIRED', 'complimentary'],
    ['PILOT', 'pilot'],
    ['MANUAL_INVOICE', 'manual'],
  ])('maps non-Stripe mode %s to %s', (billingMode, state) => {
    expect(derive(overview({ agreement: { billingMode, stripeSubscriptionId: null } })).state).toBe(
      state,
    )
  })

  it('treats a pilot as time-bounded and surfaces expiry', () => {
    const active = derive(overview({ agreement: { billingMode: 'PILOT', accessEndsAt: FUTURE } }))
    expect(active.state).toBe('pilot')
    expect(active.period).toMatchObject({ accessEndsAt: FUTURE, expired: false })
    const ended = derive(
      overview({
        agreement: { billingMode: 'PILOT', accessEndsAt: new Date('2026-09-01T00:00:00Z') },
      }),
    )
    expect(ended).toMatchObject({ state: 'pilot', nextAction: 'contact_support' })
    expect(ended.period?.expired).toBe(true)
  })

  it('derives pending states from canonical agreement and checkout records', () => {
    const live = [{ stripeCheckoutUrl: 'https://checkout.example/x', expiresAt: FUTURE }]
    const pending = derive(
      overview({ agreement: { status: 'PENDING', stripeSubscriptionId: null }, attempts: live }),
    )
    expect(pending).toMatchObject({ state: 'checkout_pending', nextAction: 'complete_payment' })
    expect(pending.actions.checkoutUrl).toBe('https://checkout.example/x')
    // Only owners may start Checkout.
    const manager = derive(
      overview({ agreement: { status: 'PENDING', stripeSubscriptionId: null }, attempts: live }),
      'MANAGER',
    )
    expect(manager.actions).toMatchObject({ canStartCheckout: false, checkoutUrl: null })
    expect(manager.nextAction).toBe('contact_support')
    // An expired link is not a payable state.
    expect(
      derive(
        overview({
          agreement: { status: 'PENDING', stripeSubscriptionId: null },
          attempts: [
            { stripeCheckoutUrl: 'https://x', expiresAt: new Date('2026-10-01T00:00:00Z') },
          ],
        }),
      ).state,
    ).toBe('no_subscription')
    expect(
      derive(overview({ agreement: { status: 'DRAFT', stripeSubscriptionId: null } })).state,
    ).toBe('no_subscription')
    // The provider already has a subscription we have not confirmed: sync pending.
    expect(derive(overview({ agreement: { status: 'PENDING' } })).state).toBe(
      'provider_sync_pending',
    )
  })

  it('maps active, open invoice, past due, grace, cancel at period end and cancelled', () => {
    expect(derive(overview()).state).toBe('active')
    const open = derive(overview({ invoices: [invoice()] }))
    expect(open).toMatchObject({ state: 'invoice_open' })
    expect(open.amountDue).toEqual({ amountMinor: 1500n, currency: 'usd', dueAt: FUTURE })
    expect(derive(overview({ agreement: { status: 'PAST_DUE' } })).state).toBe('past_due')
    expect(derive(overview({ agreement: { status: 'UNPAID' } })).state).toBe('past_due')
    expect(
      derive(overview({ accessState: 'GRACE_PERIOD', agreement: { status: 'PAST_DUE' } })).state,
    ).toBe('grace')
    expect(derive(overview({ agreement: { cancelAtPeriodEnd: true } })).state).toBe(
      'cancel_at_period_end',
    )
    expect(derive(overview({ agreement: { status: 'CANCELED' } })).state).toBe('cancelled')
    expect(derive(overview({ accessState: 'ENDED' })).state).toBe('cancelled')
  })

  it('never reports a zero or paid amount without a backing open invoice', () => {
    const active = derive(overview({ invoices: [invoice({ status: 'PAID' })] }))
    expect(active.state).toBe('active')
    expect(active.amountDue).toBeNull()
  })

  it('uses minor-unit bigint amounts, including zero-decimal currencies', () => {
    const yen = derive(
      overview({
        agreement: { currency: 'jpy', agreedAmountMinor: 1500n },
        invoices: [invoice({ currency: 'jpy', amountRemainingMinor: 1500n })],
      }),
    )
    expect(yen.plan?.price).toEqual({ amountMinor: 1500n, currency: 'jpy' })
    expect(yen.amountDue?.amountMinor).toBe(1500n)
  })

  it('reports provider sync pending for drift, error, pause or manual review', () => {
    expect(derive(overview({ health: 'DRIFT' })).state).toBe('provider_sync_pending')
    expect(derive(overview({ health: 'ERROR' })).state).toBe('provider_sync_pending')
    expect(derive(overview({ agreement: { status: 'PAUSED' } })).state).toBe(
      'provider_sync_pending',
    )
    expect(derive(overview({ agreement: { status: 'MANUAL_REVIEW' } })).state).toBe(
      'provider_sync_pending',
    )
    expect(derive(overview({ health: 'DRIFT' })).nextAction).toBe('wait')
    // A merely stale projection keeps the state but exposes the health for a warning.
    expect(derive(overview({ health: 'STALE' }))).toMatchObject({
      state: 'active',
      syncHealth: 'STALE',
    })
  })

  it('reports the newest reliable update from reconciliation or applied events only', () => {
    const result = derive(
      overview({
        lastReconciledAt: new Date('2026-09-30T00:00:00Z'),
        events: [
          { status: 'APPLIED', providerCreatedAt: new Date('2026-10-01T00:00:00Z') },
          { status: 'QUARANTINED', providerCreatedAt: new Date('2026-10-02T00:00:00Z') },
        ],
      }),
    )
    expect(result.lastReliableUpdateAt).toEqual(new Date('2026-10-01T00:00:00Z'))
    expect(derive(overview()).lastReliableUpdateAt).toBeNull()
  })

  it('offers portal and cancellation only to owners with a customer and capability', () => {
    const owner = derive(overview())
    expect(owner.actions).toMatchObject({ canManageBilling: true, canCancel: true })
    expect(owner.nextAction).toBe('manage_billing')
    const manager = derive(overview(), 'MANAGER')
    expect(manager.actions).toMatchObject({ canManageBilling: false, canCancel: false })
    expect(derive(overview({ customer: null })).actions.canManageBilling).toBe(false)
    expect(derive(overview({ portal: false })).actions.canManageBilling).toBe(false)
    expect(derive(overview({ cancellation: false })).actions.canCancel).toBe(false)
    expect(derive(overview({ agreement: { cancelAtPeriodEnd: true } })).actions.canCancel).toBe(
      false,
    )
  })

  it('produces output that satisfies the shared response schema for every derived state', () => {
    const samples = [
      overview(),
      overview({ invoices: [invoice()] }),
      overview({ agreement: { billingMode: 'PILOT', accessEndsAt: FUTURE } }),
      { ...overview(), account: null },
    ]
    for (const sample of samples) {
      expect(() => clientBillingStateResponseSchema.parse(derive(sample))).not.toThrow()
    }
  })
})

describe('billingErrorState', () => {
  it('carries no plan, amount or access claim', () => {
    const error = billingErrorState('retrieval', NOW)
    expect(error).toMatchObject({
      state: 'error',
      nextAction: 'retry',
      errorKind: 'retrieval',
      plan: null,
      amountDue: null,
      accessState: null,
      lastReliableUpdateAt: null,
    })
    expect(error.actions).toEqual({
      canStartCheckout: false,
      checkoutUrl: null,
      canManageBilling: false,
      canCancel: false,
    })
    expect(() => clientBillingStateResponseSchema.parse(error)).not.toThrow()
  })
})
