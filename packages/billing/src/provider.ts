import Stripe from 'stripe'

import { STRIPE_API_VERSION, type BillingEnvironment } from './config'

type FixedCheckoutLineItem = {
  kind: 'fixed'
  priceId: string
  quantity: number
}

type NegotiatedCheckoutLineItem = {
  kind: 'negotiated'
  productId: string
  unitAmount: number
  currency: string
  interval: 'month' | 'year'
  intervalCount: number
}

export type CheckoutSessionRequest = {
  customerId: string
  lineItem: FixedCheckoutLineItem | NegotiatedCheckoutLineItem
  successUrl: string
  cancelUrl: string
  tenantId: string
  agreementId: string
  operationId: string
  customerEmail?: string | null
}

export type PortalSessionRequest = {
  customerId: string
  returnUrl: string
  configurationId: string
}

export interface BillingProvider {
  createCustomer(input: {
    tenantId: string
    name: string
    email?: string | null
    operationId: string
  }): Promise<{ id: string }>
  createCheckoutSession(
    input: CheckoutSessionRequest,
  ): Promise<{ id: string; url: string | null; expiresAt: Date }>
  createPortalSession(input: PortalSessionRequest): Promise<{ id: string; url: string }>
  cancelSubscriptionAtPeriodEnd(input: {
    subscriptionId: string
    tenantId: string
    requestId: string
    reason: string
    operationId: string
  }): Promise<Stripe.Subscription>
  retrieveSubscription(id: string): Promise<Stripe.Subscription>
  retrieveInvoice(id: string): Promise<Stripe.Invoice>
  retrieveCharge(id: string): Promise<Stripe.Charge>
  constructWebhookEvent(payload: string | Buffer, signature: string, secret: string): Stripe.Event
}

export function createStripeClient(environment: BillingEnvironment): Stripe {
  if (!environment.STRIPE_SECRET_KEY)
    throw new BillingProviderConfigurationError('SECRET_KEY_MISSING')
  return new Stripe(environment.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
    appInfo: { name: 'Torchiko Billing', version: '1.0.0' },
    maxNetworkRetries: 2,
    timeout: 10_000,
  })
}

export class StripeBillingProvider implements BillingProvider {
  constructor(private readonly stripe: Stripe) {}

  async createCustomer(input: {
    tenantId: string
    name: string
    email?: string | null
    operationId: string
  }) {
    return this.stripe.customers.create(
      {
        name: input.name,
        ...(input.email ? { email: input.email } : {}),
        metadata: { torchiko_tenant_id: input.tenantId },
      },
      { idempotencyKey: input.operationId },
    )
  }

  async createCheckoutSession(input: CheckoutSessionRequest) {
    const lineItem: Stripe.Checkout.SessionCreateParams.LineItem =
      input.lineItem.kind === 'fixed'
        ? { price: input.lineItem.priceId, quantity: input.lineItem.quantity }
        : {
            price_data: {
              product: input.lineItem.productId,
              unit_amount: input.lineItem.unitAmount,
              currency: input.lineItem.currency,
              recurring: {
                interval: input.lineItem.interval,
                interval_count: input.lineItem.intervalCount,
              },
            },
            quantity: 1,
          }
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        payment_method_types: ['card'],
        integration_identifier: checkoutIntegrationIdentifier(input.operationId),
        customer: input.customerId,
        line_items: [lineItem],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.agreementId,
        metadata: {
          torchiko_tenant_id: input.tenantId,
          torchiko_agreement_id: input.agreementId,
          torchiko_operation_id: input.operationId,
        },
        subscription_data: {
          metadata: {
            torchiko_tenant_id: input.tenantId,
            torchiko_agreement_id: input.agreementId,
          },
        },
      },
      { idempotencyKey: input.operationId },
    )
    if (!session.expires_at)
      throw new BillingProviderConfigurationError('INVALID_PROVIDER_RESPONSE')
    return { id: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000) }
  }

  async createPortalSession(input: PortalSessionRequest) {
    return this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
      configuration: input.configurationId,
    })
  }

  cancelSubscriptionAtPeriodEnd(input: {
    subscriptionId: string
    tenantId: string
    requestId: string
    reason: string
    operationId: string
  }) {
    return this.stripe.subscriptions.update(
      input.subscriptionId,
      {
        cancel_at_period_end: true,
        metadata: {
          torchiko_tenant_id: input.tenantId,
          torchiko_cancellation_request_id: input.requestId,
          torchiko_cancellation_reason: input.reason.slice(0, 500),
        },
      },
      { idempotencyKey: `cancel:${input.operationId}` },
    )
  }

  retrieveSubscription(id: string) {
    return this.stripe.subscriptions.retrieve(id)
  }

  retrieveInvoice(id: string) {
    return this.stripe.invoices.retrieve(id)
  }

  retrieveCharge(id: string) {
    return this.stripe.charges.retrieve(id)
  }

  constructWebhookEvent(payload: string | Buffer, signature: string, secret: string) {
    return this.stripe.webhooks.constructEvent(payload, signature, secret)
  }
}

function checkoutIntegrationIdentifier(operationId: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  const suffix = [...operationId.replaceAll('-', '').slice(0, 8)]
    .map((character) => alphabet[Number.parseInt(character, 16) % alphabet.length] ?? 'a')
    .join('')
    .padEnd(8, 'a')
  return `torchiko_${suffix}`
}

export class BillingProviderConfigurationError extends Error {
  constructor(readonly code: 'SECRET_KEY_MISSING' | 'INVALID_PROVIDER_RESPONSE') {
    super(
      code === 'SECRET_KEY_MISSING'
        ? 'Stripe secret key is not configured'
        : 'Stripe returned an invalid response',
    )
    this.name = 'BillingProviderConfigurationError'
  }
}
