import type Stripe from 'stripe'

export type SubscriptionProjection = {
  stripeSubscriptionId: string
  stripeCustomerId: string
  status:
    | 'INCOMPLETE'
    | 'INCOMPLETE_EXPIRED'
    | 'TRIALING'
    | 'ACTIVE'
    | 'PAST_DUE'
    | 'CANCELED'
    | 'UNPAID'
    | 'PAUSED'
  currentPeriodStartsAt: Date | null
  currentPeriodEndsAt: Date | null
  trialStartsAt: Date | null
  trialEndsAt: Date | null
  cancelAtPeriodEnd: boolean
  cancellationEffectiveAt: Date | null
  endedAt: Date | null
  stripePriceId: string | null
  stripeProductId: string | null
  quantity: number
  tenantMetadata: string | null
  agreementMetadata: string | null
}

export function projectStripeSubscription(
  subscription: Stripe.Subscription,
): SubscriptionProjection {
  const periods = subscription.items.data
    .map((item) => ({ start: item.current_period_start, end: item.current_period_end }))
    .filter((period) => Number.isFinite(period.start) && Number.isFinite(period.end))
  const firstItem = subscription.items.data[0]
  return {
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: providerId(subscription.customer),
    status: stripeSubscriptionStatus(subscription.status),
    currentPeriodStartsAt: fromSeconds(
      periods.length ? Math.min(...periods.map((period) => period.start)) : null,
    ),
    currentPeriodEndsAt: fromSeconds(
      periods.length ? Math.max(...periods.map((period) => period.end)) : null,
    ),
    trialStartsAt: fromSeconds(subscription.trial_start),
    trialEndsAt: fromSeconds(subscription.trial_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancellationEffectiveAt: fromSeconds(subscription.cancel_at),
    endedAt: fromSeconds(subscription.ended_at),
    stripePriceId: firstItem?.price.id ?? null,
    stripeProductId: firstItem ? providerId(firstItem.price.product) : null,
    quantity: subscription.items.data.reduce((total, item) => total + (item.quantity ?? 0), 0),
    tenantMetadata: subscription.metadata?.torchiko_tenant_id ?? null,
    agreementMetadata: subscription.metadata?.torchiko_agreement_id ?? null,
  }
}

export type InvoiceProjection = {
  stripeInvoiceId: string
  stripeCustomerId: string
  stripeSubscriptionId: string | null
  invoiceNumber: string | null
  status: 'DRAFT' | 'OPEN' | 'PAID' | 'UNCOLLECTIBLE' | 'VOID'
  amountDueMinor: bigint
  amountPaidMinor: bigint
  amountRemainingMinor: bigint
  currency: string
  hostedInvoiceUrl: string | null
  invoiceDocumentUrl: string | null
  dueAt: Date | null
  paidAt: Date | null
  failedAt: Date | null
  voidedAt: Date | null
  nextRetryAt: Date | null
  failureCode: string | null
  failureSummary: string | null
}

export function projectStripeInvoice(params: {
  invoice: Stripe.Invoice
  eventType: string
  providerCreatedAt: Date
}): InvoiceProjection {
  const invoice = params.invoice
  const subscription =
    invoice.parent?.type === 'subscription_details'
      ? providerId(invoice.parent.subscription_details?.subscription)
      : null
  const failure = invoiceFailure(params.eventType)
  return {
    stripeInvoiceId: invoice.id,
    stripeCustomerId: providerId(invoice.customer),
    stripeSubscriptionId: subscription,
    invoiceNumber: invoice.number,
    status: invoiceStatus(invoice.status),
    amountDueMinor: BigInt(invoice.amount_due),
    amountPaidMinor: BigInt(invoice.amount_paid),
    amountRemainingMinor: BigInt(invoice.amount_remaining),
    currency: invoice.currency.toLowerCase(),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoiceDocumentUrl: invoice.invoice_pdf ?? null,
    dueAt: fromSeconds(invoice.due_date),
    paidAt: fromSeconds(invoice.status_transitions.paid_at),
    failedAt: failure ? params.providerCreatedAt : null,
    voidedAt: fromSeconds(invoice.status_transitions.voided_at),
    nextRetryAt: fromSeconds(invoice.next_payment_attempt),
    failureCode: failure?.code ?? null,
    failureSummary: failure?.summary ?? null,
  }
}

function invoiceFailure(eventType: string): { code: string; summary: string } | null {
  if (eventType === 'invoice.payment_failed') {
    return {
      code: 'PAYMENT_FAILED',
      summary:
        'The latest invoice payment did not complete. Update the payment method or contact support.',
    }
  }
  if (eventType === 'invoice.payment_action_required') {
    return {
      code: 'PAYMENT_ACTION_REQUIRED',
      summary: 'The latest invoice needs customer action before payment can complete.',
    }
  }
  if (eventType === 'invoice.finalization_failed') {
    return {
      code: 'FINALIZATION_FAILED',
      summary: 'The invoice could not be finalized. Torchiko support is reviewing it.',
    }
  }
  return null
}

function stripeSubscriptionStatus(
  status: Stripe.Subscription.Status,
): SubscriptionProjection['status'] {
  const upper = status.toUpperCase()
  if (
    upper === 'INCOMPLETE' ||
    upper === 'INCOMPLETE_EXPIRED' ||
    upper === 'TRIALING' ||
    upper === 'ACTIVE' ||
    upper === 'PAST_DUE' ||
    upper === 'CANCELED' ||
    upper === 'UNPAID' ||
    upper === 'PAUSED'
  ) {
    return upper
  }
  throw new BillingProjectionError('UNSUPPORTED_SUBSCRIPTION_STATUS')
}

function invoiceStatus(status: Stripe.Invoice.Status | null): InvoiceProjection['status'] {
  switch (status) {
    case 'draft':
      return 'DRAFT'
    case 'open':
      return 'OPEN'
    case 'paid':
      return 'PAID'
    case 'uncollectible':
      return 'UNCOLLECTIBLE'
    case 'void':
      return 'VOID'
    default:
      throw new BillingProjectionError('UNSUPPORTED_INVOICE_STATUS')
  }
}

function providerId(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string')
    return value.id
  throw new BillingProjectionError('PROVIDER_ID_MISSING')
}

function fromSeconds(value: number | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value * 1000)
}

export class BillingProjectionError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_SUBSCRIPTION_STATUS'
      | 'UNSUPPORTED_INVOICE_STATUS'
      | 'PROVIDER_ID_MISSING',
  ) {
    super(`Stripe billing projection failed: ${code}`)
    this.name = 'BillingProjectionError'
  }
}
