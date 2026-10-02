/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ClientBillingStateData } from '../../lib/client-billing-state'
import { BillingStateView } from './BillingStateView'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const NOW = new Date('2026-10-02T12:00:00Z')
const FUTURE = new Date('2026-11-01T12:00:00Z')

function data(overrides: Partial<ClientBillingStateData> = {}): ClientBillingStateData {
  return {
    state: 'active',
    nextAction: 'none',
    asOf: NOW,
    lastReliableUpdateAt: new Date('2026-10-01T09:30:00Z'),
    reason: null,
    errorKind: null,
    accessState: 'ACTIVE',
    syncHealth: 'CURRENT',
    plan: {
      name: 'Torchiko Pilot',
      interval: 'month',
      intervalCount: 1,
      price: { amountMinor: 1500n, currency: 'usd' },
    },
    period: {
      currentPeriodEndsAt: FUTURE,
      paidThroughAt: FUTURE,
      graceEndsAt: null,
      accessEndsAt: null,
      expired: false,
    },
    amountDue: null,
    coveredVenues: [{ id: 'v1', name: 'Harbor Museum' }],
    invoices: [],
    actions: {
      canStartCheckout: false,
      checkoutUrl: null,
      canManageBilling: false,
      canCancel: false,
    },
    ...overrides,
  }
}

const noSetup = data({
  state: 'no_setup',
  nextAction: 'contact_support',
  reason: 'no_billing_account',
  lastReliableUpdateAt: null,
  accessState: null,
  syncHealth: null,
  plan: null,
  period: null,
  coveredVenues: [],
})

describe('BillingStateView', () => {
  afterEach(cleanup)

  it('renders an honest loading state', () => {
    render(<BillingStateView view={{ status: 'loading' }} />)
    expect(screen.getByRole('status').textContent).toContain('Loading billing details')
    expect(screen.getByLabelText('Billing').getAttribute('aria-busy')).toBe('true')
  })

  it('renders forbidden without payment claims', () => {
    render(<BillingStateView view={{ status: 'forbidden' }} />)
    expect(
      screen.getByRole('heading', { name: 'Billing is visible to managers and owners' }),
    ).toBeTruthy()
    expect(screen.getByText(/This is not a payment problem/)).toBeTruthy()
    expect(screen.queryByText(/nothing is due/i)).toBeNull()
    expect(screen.getByRole('link', { name: 'Contact Torchiko' })).toBeTruthy()
  })

  it.each([
    ['retrieval', /request did not complete/],
    ['configuration', /not configured correctly/],
  ] as const)('renders a %s error with retry and no payment claim', (kind, copy) => {
    const retry = vi.fn()
    render(
      <BillingStateView
        view={{ status: 'error', kind, lastConfirmedAt: new Date('2026-10-01T09:30:00Z') }}
        onRetry={retry}
      />,
    )
    expect(
      screen.getByRole('heading', { name: 'We could not load your billing status' }),
    ).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(copy)
    expect(screen.getByRole('alert').textContent).toContain('does not mean you owe anything')
    expect(screen.getByText(/Last confirmed update:/)).toBeTruthy()
    expect(screen.queryByText(/is active|Amount due|paid/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('treats a server error state as an error, never as no subscription', () => {
    render(
      <BillingStateView
        view={{
          status: 'ready',
          data: data({ state: 'error', errorKind: 'retrieval', plan: null }),
        }}
        onRetry={() => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByText(/no subscription/i)).toBeNull()
  })

  it('tells a tenant without billing setup that no payment has been requested', () => {
    render(<BillingStateView view={{ status: 'ready', data: noSetup }} />)
    expect(
      screen.getByRole('heading', { name: 'Your Torchiko team has not set up billing yet' }),
    ).toBeTruthy()
    expect(screen.getByText(/No payment has been requested through this page/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Contact Torchiko' }).getAttribute('href')).toBe(
      '/support',
    )
    expect(screen.getByTestId('billing-last-update').textContent).toContain(
      'No payment-provider update has been recorded',
    )
  })

  it.each<[ClientBillingStateData['state'], Partial<ClientBillingStateData>, string, RegExp]>([
    ['complimentary', { nextAction: 'none' }, 'Complimentary', /Your access is complimentary/],
    [
      'pilot',
      { period: { ...data().period!, accessEndsAt: FUTURE } },
      'Pilot',
      /You are on a Torchiko pilot/,
    ],
    ['manual', { nextAction: 'contact_support' }, 'Managed by Torchiko', /arranged directly/],
    [
      'no_subscription',
      { nextAction: 'contact_support' },
      'No subscription',
      /no subscription to pay yet/,
    ],
    [
      'checkout_pending',
      {
        nextAction: 'complete_payment',
        actions: {
          canStartCheckout: true,
          checkoutUrl: 'https://checkout.example/x',
          canManageBilling: false,
          canCancel: false,
        },
      },
      'Payment to complete',
      /waiting for payment/,
    ],
    ['active', {}, 'Active', /Your subscription is active/],
    [
      'invoice_open',
      { amountDue: { amountMinor: 1500n, currency: 'usd', dueAt: FUTURE } },
      'Invoice open',
      /open invoice/,
    ],
    [
      'past_due',
      { nextAction: 'contact_support' },
      'Payment needs attention',
      /did not go through/,
    ],
    [
      'grace',
      { period: { ...data().period!, graceEndsAt: FUTURE } },
      'Grace period',
      /payment grace period/,
    ],
    ['cancel_at_period_end', {}, 'Ending', /will end at the close of this period/],
    ['cancelled', { nextAction: 'contact_support' }, 'Ended', /subscription has ended/],
    [
      'provider_sync_pending',
      { nextAction: 'wait' },
      'Confirming',
      /confirming your billing details/,
    ],
  ])(
    'renders the %s state with a label, heading and last-update time',
    (state, overrides, label, heading) => {
      render(<BillingStateView view={{ status: 'ready', data: data({ state, ...overrides }) }} />)
      expect(screen.getByTestId('billing-state-label').textContent).toBe(label)
      expect(screen.getByRole('heading', { level: 2, name: heading })).toBeTruthy()
      expect(screen.getByTestId('billing-last-update').textContent).toContain(
        'Last confirmed with the payment provider',
      )
      expect(screen.getByText('Harbor Museum')).toBeTruthy()
    },
  )

  it('formats money from minor units and shows the due amount only when backed', () => {
    const { rerender } = render(
      <BillingStateView
        view={{
          status: 'ready',
          data: data({
            state: 'invoice_open',
            amountDue: { amountMinor: 1500n, currency: 'jpy', dueAt: FUTURE },
          }),
        }}
      />,
    )
    expect(screen.getByText('¥1,500')).toBeTruthy()
    rerender(<BillingStateView view={{ status: 'ready', data: data({ state: 'active' }) }} />)
    expect(screen.queryByText(/Amount due/)).toBeNull()
  })

  it('shows pilot and grace dates, and flags an ended pilot', () => {
    const { rerender } = render(
      <BillingStateView
        view={{
          status: 'ready',
          data: data({
            state: 'pilot',
            period: { ...data().period!, accessEndsAt: FUTURE },
          }),
        }}
      />,
    )
    expect(screen.getByText(/Your pilot runs until November 1, 2026/)).toBeTruthy()
    rerender(
      <BillingStateView
        view={{
          status: 'ready',
          data: data({
            state: 'pilot',
            nextAction: 'contact_support',
            period: {
              ...data().period!,
              // Rendered dates use the viewer's locale; use local noon to keep this fixture on September 1.
              accessEndsAt: new Date(2026, 8, 1, 12),
              expired: true,
            },
          }),
        }}
      />,
    )
    expect(screen.getByText(/Your pilot ended on September/)).toBeTruthy()
  })

  it('offers only the actions the server allowed', () => {
    const manage = vi.fn()
    const cancel = vi.fn()
    const checkout = vi.fn()
    const { rerender } = render(
      <BillingStateView
        view={{
          status: 'ready',
          data: data({
            nextAction: 'manage_billing',
            actions: {
              canStartCheckout: false,
              checkoutUrl: null,
              canManageBilling: true,
              canCancel: true,
            },
          }),
        }}
        onManageBilling={manage}
        onRequestCancellation={cancel}
        onCheckout={checkout}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Manage billing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }))
    expect(manage).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Complete payment' })).toBeNull()

    rerender(
      <BillingStateView
        view={{ status: 'ready', data: data() }}
        onManageBilling={manage}
        onRequestCancellation={cancel}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel subscription' })).toBeNull()
  })

  it('warns when provider confirmation is stale', () => {
    render(<BillingStateView view={{ status: 'ready', data: data({ syncHealth: 'STALE' }) }} />)
    expect(screen.getByText(/Provider confirmation is overdue/)).toBeTruthy()
  })
})
