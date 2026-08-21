import Stripe from 'stripe'

export const SUPPORTED_STRIPE_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.expired',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.created',
  'customer.updated',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',
  'invoice.created',
  'invoice.finalized',
  'invoice.finalization_failed',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'invoice.updated',
  'invoice.voided',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.requires_action',
  'charge.dispute.created',
  'refund.created',
  'refund.updated',
  'refund.failed',
] as const satisfies readonly Stripe.Event.Type[]

export type SupportedStripeEventType = (typeof SUPPORTED_STRIPE_EVENT_TYPES)[number]

const supported = new Set<string>(SUPPORTED_STRIPE_EVENT_TYPES)

export function isSupportedStripeEventType(value: string): value is SupportedStripeEventType {
  return supported.has(value)
}

export function normalizedStripeObjectReference(event: Stripe.Event): {
  objectId: string | null
  customerId: string | null
  subscriptionId: string | null
  invoiceId: string | null
} {
  const object = event.data.object as unknown as Record<string, unknown>
  const parent =
    object.parent && typeof object.parent === 'object'
      ? (object.parent as Record<string, unknown>)
      : null
  const subscriptionDetails =
    parent?.subscription_details && typeof parent.subscription_details === 'object'
      ? (parent.subscription_details as Record<string, unknown>)
      : null
  return {
    objectId: typeof object.id === 'string' ? object.id : null,
    customerId:
      event.type.startsWith('customer.') && !event.type.startsWith('customer.subscription.')
        ? providerId(object.id)
        : providerId(object.customer),
    subscriptionId:
      event.type.startsWith('customer.subscription.') && typeof object.id === 'string'
        ? object.id
        : (providerId(object.subscription) ?? providerId(subscriptionDetails?.subscription)),
    invoiceId:
      event.type.startsWith('invoice.') && typeof object.id === 'string'
        ? object.id
        : providerId(object.invoice),
  }
}

function providerId(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string')
    return value.id
  return null
}

export function sanitizedStripeEventSummary(event: Stripe.Event) {
  const reference = normalizedStripeObjectReference(event)
  return {
    type: event.type,
    livemode: event.livemode,
    apiVersion: event.api_version ?? null,
    objectId: reference.objectId,
    customerId: reference.customerId,
    subscriptionId: reference.subscriptionId,
    invoiceId: reference.invoiceId,
  }
}
