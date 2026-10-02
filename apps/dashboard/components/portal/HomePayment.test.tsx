/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => ({}) }))

import type { ClientBillingOverview } from '../../lib/client-billing-presentation'
import { HomePaymentView, summarizeHomePayment } from './HomePayment'

function overview(
  agreement: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): ClientBillingOverview {
  return {
    enabled: true,
    capabilities: { checkout: true, portal: true, cancellation: true },
    catalog: [{ key: 'guide', version: 1, displayName: 'Visitor guide' }],
    venues: [],
    access: { state: 'ACTIVE', reason: 'Paid through October 31, 2026.' },
    hasStripeCustomer: true,
    currentCheckoutUrl: null,
    addOnCatalog: [],
    account: {
      billingMode: 'STRIPE_SUBSCRIPTION',
      currency: 'usd',
      status: 'ACTIVE',
      paidThroughAt: new Date('2026-10-31T12:00:00.000Z'),
      gracePeriodEndsAt: null,
      reconciliationHealth: 'HEALTHY',
      lastReconciledAt: null,
      commercialAgreements: [
        {
          id: 'a',
          isBase: true,
          internalPlanKey: 'guide',
          internalPlanVersion: 1,
          status: 'ACTIVE',
          billingMode: 'STRIPE_SUBSCRIPTION',
          billingInterval: 'MONTH',
          agreedAmountMinor: 24900,
          venuePriceBreakdownComplete: true,
          currency: 'usd',
          cancelAtPeriodEnd: false,
          currentPeriodEndsAt: new Date('2026-10-31T12:00:00.000Z'),
          accessEndsAt: null,
          coveredVenues: [],
          ...agreement,
        },
      ],
      invoiceProjections: [],
      customerRequests: [],
    },
    ...extra,
  } as unknown as ClientBillingOverview
}

describe('Home payment', () => {
  afterEach(cleanup)

  it('says paid through the account’s real date when nothing is owed', () => {
    expect(summarizeHomePayment(overview({}), true)).toEqual({
      kind: 'settled',
      headline: 'Paid through October 31, 2026',
      detail: null,
    })
  })

  it('offers one Pay action through the existing checkout link, owners only', () => {
    const due = overview(
      { status: 'PENDING', currentPeriodEndsAt: null },
      { currentCheckoutUrl: 'https://checkout.stripe.test/session' },
    )
    expect(summarizeHomePayment(due, true)).toMatchObject({
      kind: 'due',
      headline: 'Payment needed to get started',
      pay: { kind: 'checkout', url: 'https://checkout.stripe.test/session' },
    })
    expect(summarizeHomePayment(due, false)).toMatchObject({ kind: 'due', pay: null })
  })

  it('routes a past-due account to the billing portal instead of inventing a charge', () => {
    const pastDue = overview({ status: 'PAST_DUE' })
    expect(summarizeHomePayment(pastDue, true)).toMatchObject({
      kind: 'due',
      headline: 'Payment is past due',
      pay: { kind: 'portal' },
    })
  })

  it('never claims a pending payment is settled or due without a checkout', () => {
    expect(summarizeHomePayment(overview({ status: 'PENDING' }), true)).toEqual({
      kind: 'settled',
      headline: 'Confirming your payment',
      detail: null,
    })
    expect(summarizeHomePayment(overview({ billingMode: 'COMPLIMENTARY' }), true)).toMatchObject({
      headline: 'No payment needed',
    })
    expect(summarizeHomePayment({ ...overview({}), enabled: false }, true)).toEqual({
      kind: 'hidden',
    })
  })

  it('renders loading, error and due states honestly and uses ember only when something is owed', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<HomePaymentView summary={{ kind: 'loading' }} />)
    expect(screen.getByText('Checking your payment status…')).toBeTruthy()

    rerender(<HomePaymentView summary={{ kind: 'error' }} onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalled()

    rerender(
      <HomePaymentView
        summary={{ kind: 'settled', headline: 'Paid through October 31, 2026', detail: null }}
      />,
    )
    expect(screen.queryByRole('link', { name: 'Pay now' })).toBeNull()
    expect(document.querySelector('.bg-tk-ember-text')).toBeNull()

    rerender(
      <HomePaymentView
        summary={{
          kind: 'due',
          headline: 'Payment needed to get started',
          detail: null,
          pay: { kind: 'checkout', url: 'https://checkout.stripe.test/session' },
        }}
      />,
    )
    expect(screen.getByRole('link', { name: 'Pay now' }).getAttribute('href')).toBe(
      'https://checkout.stripe.test/session',
    )
    expect(screen.getAllByRole('link', { name: 'Pay now' })).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Billing details' }).getAttribute('href')).toBe(
      '/payment',
    )
  })
})
