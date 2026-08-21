import { describe, expect, it } from 'vitest'
import type Stripe from 'stripe'

import { normalizedStripeObjectReference } from './webhook-events'

describe('Stripe webhook object identity', () => {
  it('maps a customer object to its own provider id', () => {
    const event = { type: 'customer.updated', data: { object: { id: 'cus_test' } } } as Stripe.Event
    expect(normalizedStripeObjectReference(event).customerId).toBe('cus_test')
  })

  it('maps a modern invoice parent subscription', () => {
    const event = {
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_test',
          customer: 'cus_test',
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: 'sub_test' },
          },
        },
      },
    } as unknown as Stripe.Event
    expect(normalizedStripeObjectReference(event)).toMatchObject({
      invoiceId: 'in_test',
      customerId: 'cus_test',
      subscriptionId: 'sub_test',
    })
  })
})
