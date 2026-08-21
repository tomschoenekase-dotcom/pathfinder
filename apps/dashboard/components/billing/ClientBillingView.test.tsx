/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ClientBillingView,
  type ClientBillingState,
  type ClientBillingViewModel,
} from './ClientBillingView'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const billing: ClientBillingViewModel = {
  planName: 'Torchiko Pilot',
  arrangementLabel: 'Stripe subscription',
  amountLabel: '$25.00',
  intervalLabel: 'per month',
  statusDetail: 'Your subscription renews automatically unless it is canceled.',
  nextBillingLabel: 'September 20, 2026',
  paidThroughLabel: 'September 20, 2026',
  coveredVenues: [
    { id: 'venue-1', name: 'Harbor Museum' },
    { id: 'venue-2', name: 'Hill Park' },
  ],
  invoices: [
    {
      id: 'invoice-1',
      number: 'TST-0001',
      statusLabel: 'Paid',
      amountLabel: '$25.00',
      dateLabel: 'August 20, 2026',
      documentUrl: 'https://invoice.example/test',
    },
  ],
  canStartCheckout: false,
  canRetryCheckout: false,
  canManageBilling: true,
  supportUrl: '/support',
}

describe('ClientBillingView', () => {
  afterEach(cleanup)

  it.each<[ClientBillingState, string]>([
    ['pending', 'Confirmation pending'],
    ['active', 'Active'],
    ['past_due', 'Payment needs attention'],
    ['grace', 'Grace period'],
    ['canceled', 'Ending or canceled'],
    ['manual', 'Managed by Torchiko'],
    ['complimentary', 'Complimentary access'],
  ])('renders the %s state with explicit status text', (state, label) => {
    render(<ClientBillingView state={state} billing={billing} />)
    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Covered venues' })).toBeTruthy()
    expect(screen.getByText('Harbor Museum')).toBeTruthy()
  })

  it('renders honest loading and empty states', () => {
    const { rerender } = render(<ClientBillingView state="loading" billing={null} />)
    expect(screen.getByRole('status').textContent).toContain('Loading billing details')
    expect(screen.getByLabelText('Billing').getAttribute('aria-busy')).toBe('true')

    rerender(<ClientBillingView state="empty" billing={null} />)
    expect(screen.getByRole('heading', { name: 'No billing arrangement yet' })).toBeTruthy()
  })

  it('shows reconciliation and failure recovery without exposing provider internals', () => {
    const retry = vi.fn()
    const unsafeInput = {
      ...billing,
      canManageBilling: false,
      canRetryCheckout: true,
      internalNote: 'Do not show this internal note',
      stripeCustomerId: 'cus_private_test_identifier',
      rawPayload: '{"card":"secret"}',
    }
    render(
      <ClientBillingView
        state="past_due"
        billing={unsafeInput}
        reconciliationWarning="A recent provider update has not finished syncing."
        onRetryCheckout={retry}
      />,
    )

    expect(screen.getByText('Billing update in progress')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try payment again' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(document.body.textContent).not.toContain('Do not show this internal note')
    expect(document.body.textContent).not.toContain('cus_private_test_identifier')
    expect(document.body.textContent).not.toContain('card')
  })

  it('renders invoice links and client actions with safe interaction semantics', () => {
    const manage = vi.fn()
    render(<ClientBillingView state="active" billing={billing} onManageBilling={manage} />)
    const invoice = screen.getByRole('link', { name: 'Open TST-0001 in a new tab' })
    expect(invoice.getAttribute('target')).toBe('_blank')
    expect(invoice.getAttribute('rel')).toBe('noreferrer')
    expect(screen.getByRole('link', { name: 'Contact support' }).getAttribute('href')).toBe(
      '/support',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Manage billing' }))
    expect(manage).toHaveBeenCalledOnce()
  })

  it('offers cancellation and records add-on interest without implying an immediate charge', () => {
    const cancel = vi.fn()
    const interest = vi.fn()
    render(
      <ClientBillingView
        state="active"
        billing={{
          ...billing,
          canCancel: true,
          addOns: [
            {
              key: 'premium-voice',
              label: 'Premium voice mode',
              description: 'Natural voice conversations.',
              interested: false,
            },
          ],
        }}
        onRequestCancellation={cancel}
        onAddOnInterest={interest}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }))
    fireEvent.click(screen.getByRole('button', { name: "I'm interested" }))
    expect(cancel).toHaveBeenCalledOnce()
    expect(interest).toHaveBeenCalledWith('premium-voice')
    expect(screen.getByText(/before anything changes/i)).toBeTruthy()
    expect(screen.getByText(/Torchiko absorbs processing fees/i)).toBeTruthy()
  })

  it('has no automated accessibility violations in a dense grace-period state', async () => {
    const { container } = render(
      <ClientBillingView
        state="grace"
        billing={billing}
        reconciliationWarning="The latest payment status is being reconciled."
        onManageBilling={vi.fn()}
      />,
    )
    document.documentElement.lang = 'en'
    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(result.violations).toEqual([])
  })
})
