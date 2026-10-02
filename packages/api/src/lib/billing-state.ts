import type { TenantRole } from '@pathfinder/auth'

import type { ClientBillingStateResponse } from '../schemas/billing-state'

/** Structural subset of `getTenantBillingOverview` so derivation stays a pure, testable function. */
export type BillingOverviewInput = {
  enabled: boolean
  capabilities: { checkout: boolean; portal: boolean; cancellation: boolean }
  catalog: ReadonlyArray<{ key: string; version: number; displayName: string }>
  access: { state: string } | null
  account: {
    paidThroughAt: Date | null
    gracePeriodEndsAt: Date | null
    reconciliationHealth: 'UNKNOWN' | 'CURRENT' | 'STALE' | 'DRIFT' | 'ERROR'
    lastReconciledAt: Date | null
    stripeCustomerId: string | null
    checkoutAttempts: ReadonlyArray<{ stripeCheckoutUrl: string | null; expiresAt: Date | null }>
    eventApplications: ReadonlyArray<{ status: string; providerCreatedAt: Date | null }>
    commercialAgreements: ReadonlyArray<{
      isBase: boolean
      internalPlanKey: string
      internalPlanVersion: number
      status: string
      billingMode: string
      billingInterval: string
      billingIntervalCount: number
      agreedAmountMinor: bigint | null
      currency: string
      stripeSubscriptionId: string | null
      cancelAtPeriodEnd: boolean
      currentPeriodEndsAt: Date | null
      accessEndsAt: Date | null
      coveredVenues: ReadonlyArray<{ venue: { id: string; name: string } }>
    }>
    invoiceProjections: ReadonlyArray<{
      id: string
      invoiceNumber: string | null
      status: string
      amountDueMinor: bigint
      amountRemainingMinor: bigint
      currency: string
      dueAt: Date | null
      paidAt: Date | null
      createdAt: Date
      invoiceDocumentUrl: string | null
      hostedInvoiceUrl: string | null
    }>
  } | null
}

type Base = Omit<ClientBillingStateResponse, 'state' | 'nextAction' | 'reason' | 'errorKind'>

function emptyBase(now: Date): Base {
  return {
    asOf: now,
    lastReliableUpdateAt: null,
    accessState: null,
    syncHealth: null,
    plan: null,
    period: null,
    amountDue: null,
    coveredVenues: [],
    invoices: [],
    actions: {
      canStartCheckout: false,
      checkoutUrl: null,
      canManageBilling: false,
      canCancel: false,
    },
  }
}

/** An error never carries a payment claim: no plan, no amount, no access state. */
export function billingErrorState(
  kind: 'retrieval' | 'configuration',
  now = new Date(),
): ClientBillingStateResponse {
  return {
    ...emptyBase(now),
    state: 'error',
    nextAction: 'retry',
    reason: null,
    errorKind: kind,
  }
}

function newest(dates: ReadonlyArray<Date | null>): Date | null {
  let best: Date | null = null
  for (const date of dates) if (date && (!best || date > best)) best = date
  return best
}

export function deriveClientBillingState(input: {
  overview: BillingOverviewInput
  role: TenantRole
  now?: Date
}): ClientBillingStateResponse {
  const now = input.now ?? new Date()
  const { overview } = input
  const noSetup = (
    reason: NonNullable<ClientBillingStateResponse['reason']>,
  ): ClientBillingStateResponse => ({
    ...emptyBase(now),
    state: 'no_setup',
    nextAction: 'contact_support',
    reason,
    errorKind: null,
  })

  if (!overview.enabled) return noSetup('billing_not_enabled')
  const account = overview.account
  if (!account) return noSetup('no_billing_account')
  const agreement =
    account.commercialAgreements.find((item) => item.isBase) ?? account.commercialAgreements[0]
  if (!agreement) return noSetup('no_agreement')

  const isOwner = input.role === 'OWNER'
  const catalogPlan = overview.catalog.find(
    (plan) =>
      plan.key === agreement.internalPlanKey && plan.version === agreement.internalPlanVersion,
  )
  const openInvoice = account.invoiceProjections.find((invoice) => invoice.status === 'OPEN')
  const liveAttempt = account.checkoutAttempts.find(
    (attempt) => attempt.stripeCheckoutUrl && attempt.expiresAt && attempt.expiresAt > now,
  )
  const mode = agreement.billingMode
  const stripeMode = mode === 'STRIPE_SUBSCRIPTION' || mode === 'STRIPE_INVOICE'
  const accessEnded = agreement.accessEndsAt !== null && agreement.accessEndsAt <= now
  const canManageBilling =
    isOwner && stripeMode && overview.capabilities.portal && Boolean(account.stripeCustomerId)
  const canCheckout = isOwner && overview.capabilities.checkout
  const health = account.reconciliationHealth

  const lastReliableUpdateAt = newest([
    account.lastReconciledAt,
    ...account.eventApplications
      .filter((event) => event.status === 'APPLIED')
      .map((event) => event.providerCreatedAt),
  ])

  let state: ClientBillingStateResponse['state']
  let nextAction: ClientBillingStateResponse['nextAction'] = 'none'

  if (mode === 'COMPLIMENTARY' || mode === 'NO_BILLING_REQUIRED') {
    state = 'complimentary'
  } else if (mode === 'PILOT') {
    state = 'pilot'
    if (accessEnded) nextAction = 'contact_support'
  } else if (mode === 'MANUAL_INVOICE') {
    state = 'manual'
    nextAction = 'contact_support'
  } else if (overview.access?.state === 'GRACE_PERIOD') {
    state = 'grace'
    nextAction = canManageBilling ? 'update_payment' : 'contact_support'
  } else if (
    agreement.status === 'CANCELED' ||
    agreement.status === 'ENDED' ||
    overview.access?.state === 'ENDED'
  ) {
    state = 'cancelled'
    nextAction = 'contact_support'
  } else if (agreement.status === 'PAST_DUE' || agreement.status === 'UNPAID') {
    state = 'past_due'
    nextAction = canManageBilling ? 'update_payment' : 'contact_support'
  } else if (
    agreement.status === 'PAUSED' ||
    agreement.status === 'MANUAL_REVIEW' ||
    health === 'DRIFT' ||
    health === 'ERROR' ||
    (agreement.status === 'PENDING' && Boolean(agreement.stripeSubscriptionId))
  ) {
    state = 'provider_sync_pending'
    nextAction = 'wait'
  } else if (agreement.status === 'PENDING') {
    if (liveAttempt) {
      state = 'checkout_pending'
      nextAction = canCheckout ? 'complete_payment' : 'contact_support'
    } else {
      state = 'no_subscription'
      nextAction = 'contact_support'
    }
  } else if (agreement.status === 'DRAFT') {
    state = 'no_subscription'
    nextAction = 'contact_support'
  } else if (agreement.cancelAtPeriodEnd) {
    state = 'cancel_at_period_end'
    nextAction = canManageBilling ? 'manage_billing' : 'contact_support'
  } else if (openInvoice) {
    state = 'invoice_open'
    nextAction = canManageBilling ? 'manage_billing' : 'contact_support'
  } else {
    state = 'active'
    nextAction = canManageBilling ? 'manage_billing' : 'none'
  }

  return {
    state,
    nextAction,
    asOf: now,
    lastReliableUpdateAt,
    reason: null,
    errorKind: null,
    accessState: overview.access?.state ?? null,
    syncHealth: health,
    plan: {
      name: catalogPlan?.displayName ?? agreement.internalPlanKey.replaceAll('_', ' '),
      interval: agreement.billingInterval.toLowerCase(),
      intervalCount: agreement.billingIntervalCount,
      price:
        agreement.agreedAmountMinor === null
          ? null
          : { amountMinor: agreement.agreedAmountMinor, currency: agreement.currency },
    },
    period: {
      currentPeriodEndsAt: agreement.currentPeriodEndsAt,
      paidThroughAt: account.paidThroughAt,
      graceEndsAt: account.gracePeriodEndsAt,
      accessEndsAt: agreement.accessEndsAt,
      expired: accessEnded,
    },
    // Only an OPEN invoice projection is evidence of money owed; absence is never reported as zero.
    amountDue: openInvoice
      ? {
          amountMinor:
            openInvoice.amountRemainingMinor > 0n
              ? openInvoice.amountRemainingMinor
              : openInvoice.amountDueMinor,
          currency: openInvoice.currency,
          dueAt: openInvoice.dueAt,
        }
      : null,
    coveredVenues: agreement.coveredVenues.map((coverage) => ({
      id: coverage.venue.id,
      name: coverage.venue.name,
    })),
    invoices: account.invoiceProjections.map((invoice) => ({
      id: invoice.id,
      number: invoice.invoiceNumber,
      status: invoice.status,
      amountDue: { amountMinor: invoice.amountDueMinor, currency: invoice.currency },
      date: invoice.paidAt ?? invoice.dueAt ?? invoice.createdAt,
      url: invoice.invoiceDocumentUrl ?? invoice.hostedInvoiceUrl,
    })),
    actions: {
      canStartCheckout: state === 'checkout_pending' && canCheckout,
      checkoutUrl:
        state === 'checkout_pending' && canCheckout
          ? (liveAttempt?.stripeCheckoutUrl ?? null)
          : null,
      canManageBilling,
      canCancel:
        isOwner &&
        stripeMode &&
        overview.capabilities.cancellation &&
        (state === 'active' || state === 'invoice_open') &&
        !agreement.cancelAtPeriodEnd,
    },
  }
}
