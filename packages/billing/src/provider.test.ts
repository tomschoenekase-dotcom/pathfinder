import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'

import { StripeBillingProvider } from './provider'

function fixture() {
  const createCustomer = vi.fn().mockResolvedValue({ id: 'cus_test' })
  const createCheckout = vi.fn().mockResolvedValue({
    id: 'cs_test',
    url: 'https://checkout.stripe.test/cs_test',
    expires_at: 1_800_000_000,
  })
  const createPortal = vi
    .fn()
    .mockResolvedValue({ id: 'bps_test', url: 'https://billing.stripe.test/session' })
  const constructEvent = vi.fn().mockReturnValue({ id: 'evt_test' })
  const stripe = {
    customers: { create: createCustomer },
    checkout: { sessions: { create: createCheckout } },
    billingPortal: { sessions: { create: createPortal } },
    subscriptions: { retrieve: vi.fn() },
    invoices: { retrieve: vi.fn() },
    charges: { retrieve: vi.fn() },
    webhooks: { constructEvent },
  } as unknown as Stripe
  return {
    provider: new StripeBillingProvider(stripe),
    createCustomer,
    createCheckout,
    createPortal,
    constructEvent,
  }
}

describe('Stripe provider adapter', () => {
  it('creates a server-owned subscription Checkout session with correlation metadata and idempotency', async () => {
    const { provider, createCheckout } = fixture()
    await provider.createCheckoutSession({
      customerId: 'cus_test',
      lineItem: { kind: 'fixed', priceId: 'price_test', quantity: 2 },
      successUrl: 'https://dashboard.test/settings/billing/success',
      cancelUrl: 'https://dashboard.test/settings/billing/canceled',
      tenantId: 'tenant-a',
      agreementId: 'agreement-a',
      operationId: 'operation-a',
    })
    expect(createCheckout).toHaveBeenCalledWith(
      {
        mode: 'subscription',
        payment_method_types: ['card'],
        integration_identifier: 'torchiko_aaoakaaa',
        customer: 'cus_test',
        line_items: [{ price: 'price_test', quantity: 2 }],
        success_url: 'https://dashboard.test/settings/billing/success',
        cancel_url: 'https://dashboard.test/settings/billing/canceled',
        client_reference_id: 'agreement-a',
        metadata: {
          torchiko_tenant_id: 'tenant-a',
          torchiko_agreement_id: 'agreement-a',
          torchiko_operation_id: 'operation-a',
        },
        subscription_data: {
          metadata: { torchiko_tenant_id: 'tenant-a', torchiko_agreement_id: 'agreement-a' },
        },
      },
      { idempotencyKey: 'operation-a' },
    )
  })

  it('creates an inline recurring price for an approved negotiated total', async () => {
    const { provider, createCheckout } = fixture()
    await provider.createCheckoutSession({
      customerId: 'cus_test',
      lineItem: {
        kind: 'negotiated',
        productId: 'prod_torchiko_test',
        unitAmount: 3750,
        currency: 'usd',
        interval: 'month',
        intervalCount: 1,
      },
      successUrl: 'https://dashboard.test/settings/billing/success',
      cancelUrl: 'https://dashboard.test/settings/billing/canceled',
      tenantId: 'tenant-a',
      agreementId: 'agreement-a',
      operationId: 'operation-negotiated-a',
    })
    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          {
            price_data: {
              product: 'prod_torchiko_test',
              unit_amount: 3750,
              currency: 'usd',
              recurring: { interval: 'month', interval_count: 1 },
            },
            quantity: 1,
          },
        ],
      }),
      { idempotencyKey: 'operation-negotiated-a' },
    )
  })

  it('uses the linked customer and dedicated configuration for Portal', async () => {
    const { provider, createPortal } = fixture()
    await provider.createPortalSession({
      customerId: 'cus_test',
      returnUrl: 'https://dashboard.test/settings',
      configurationId: 'bpc_restrictive',
    })
    expect(createPortal).toHaveBeenCalledWith({
      customer: 'cus_test',
      return_url: 'https://dashboard.test/settings',
      configuration: 'bpc_restrictive',
    })
  })

  it('passes exact raw bytes and the endpoint secret to Stripe signature verification', () => {
    const { provider, constructEvent } = fixture()
    const raw = Buffer.from('{ "spacing": true }', 'utf8')
    provider.constructWebhookEvent(raw, 't=1,v1=fake', 'whsec_endpoint')
    expect(constructEvent).toHaveBeenCalledWith(raw, 't=1,v1=fake', 'whsec_endpoint')
  })
})
