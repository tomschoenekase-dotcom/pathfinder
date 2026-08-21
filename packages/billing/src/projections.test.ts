import { describe, expect, it } from 'vitest'
import type Stripe from 'stripe'

import { projectStripeInvoice, projectStripeSubscription } from './projections'

describe('Stripe projection mapping', () => {
  it('folds subscription item periods and correlation metadata', () => {
    const subscription = {
      id: 'sub_test',
      customer: 'cus_test',
      status: 'active',
      cancel_at_period_end: true,
      cancel_at: 1_787_000_000,
      ended_at: null,
      trial_start: null,
      trial_end: null,
      metadata: { torchiko_tenant_id: 'tenant_1', torchiko_agreement_id: 'agreement_1' },
      items: {
        data: [
          {
            current_period_start: 1_777_000_000,
            current_period_end: 1_780_000_000,
            quantity: 2,
            price: { id: 'price_test', product: 'prod_test' },
          },
        ],
      },
    } as unknown as Stripe.Subscription

    expect(projectStripeSubscription(subscription)).toMatchObject({
      stripeSubscriptionId: 'sub_test',
      stripeCustomerId: 'cus_test',
      status: 'ACTIVE',
      cancelAtPeriodEnd: true,
      stripePriceId: 'price_test',
      stripeProductId: 'prod_test',
      quantity: 2,
      tenantMetadata: 'tenant_1',
      agreementMetadata: 'agreement_1',
    })
  })

  it('uses invoice.paid projection without a raw provider error', () => {
    const invoice = {
      id: 'in_test',
      customer: 'cus_test',
      number: 'TST-0001',
      status: 'paid',
      amount_due: 1500,
      amount_paid: 1500,
      amount_remaining: 0,
      currency: 'usd',
      hosted_invoice_url: 'https://invoice.stripe.test/i/test',
      invoice_pdf: 'https://invoice.stripe.test/i/test.pdf',
      due_date: null,
      next_payment_attempt: null,
      status_transitions: { paid_at: 1_777_000_000, voided_at: null },
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_test' } },
    } as unknown as Stripe.Invoice
    expect(
      projectStripeInvoice({ invoice, eventType: 'invoice.paid', providerCreatedAt: new Date() }),
    ).toMatchObject({
      stripeInvoiceId: 'in_test',
      stripeSubscriptionId: 'sub_test',
      status: 'PAID',
      amountPaidMinor: 1500n,
      failureSummary: null,
    })
  })

  it('exposes a bounded customer-safe failure summary', () => {
    const invoice = {
      id: 'in_failed',
      customer: 'cus_test',
      number: null,
      status: 'open',
      amount_due: 1500,
      amount_paid: 0,
      amount_remaining: 1500,
      currency: 'usd',
      hosted_invoice_url: null,
      invoice_pdf: null,
      due_date: null,
      next_payment_attempt: 1_777_100_000,
      status_transitions: { paid_at: null, voided_at: null },
      parent: null,
    } as unknown as Stripe.Invoice
    const projected = projectStripeInvoice({
      invoice,
      eventType: 'invoice.payment_failed',
      providerCreatedAt: new Date('2026-08-20T12:00:00Z'),
    })
    expect(projected.failureCode).toBe('PAYMENT_FAILED')
    expect(projected.failureSummary).not.toMatch(/card|decline code|secret/iu)
  })
})
