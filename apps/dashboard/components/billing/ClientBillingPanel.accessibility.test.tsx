/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ overview: vi.fn() }))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    billing: {
      overview: { query: mocks.overview },
      createCheckout: { mutate: vi.fn() },
      createPortal: { mutate: vi.fn() },
      requestCancellation: { mutate: vi.fn() },
      recordAddOnInterest: { mutate: vi.fn() },
    },
  }),
}))
vi.mock('./ClientBillingView', () => ({
  ClientBillingView: ({ onRequestCancellation }: { onRequestCancellation?: () => void }) =>
    onRequestCancellation ? (
      <button type="button" onClick={onRequestCancellation}>
        Cancel subscription
      </button>
    ) : (
      <p role="status">Loading billing</p>
    ),
}))

import { ClientBillingPanel } from './ClientBillingPanel'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const overview = {
  enabled: true,
  account: {
    commercialAgreements: [
      {
        isBase: true,
        billingMode: 'STRIPE_SUBSCRIPTION',
        status: 'ACTIVE',
        internalPlanKey: 'torchiko-pilot',
        internalPlanVersion: 1,
        agreedAmountMinor: 2500,
        currency: 'usd',
        billingInterval: 'MONTHLY',
        cancelAtPeriodEnd: false,
        currentPeriodEndsAt: new Date('2026-09-20T12:00:00Z'),
        accessEndsAt: null,
        venuePriceBreakdownComplete: true,
        coveredVenues: [],
      },
    ],
    paidThroughAt: null,
    invoiceProjections: [],
    customerRequests: [],
    reconciliationHealth: 'HEALTHY',
  },
  access: { state: 'ACTIVE', reason: 'Subscription active' },
  catalog: [{ key: 'torchiko-pilot', version: 1, displayName: 'Torchiko Pilot' }],
  capabilities: { checkout: false, portal: false, cancellation: true },
  hasStripeCustomer: true,
  currentCheckoutUrl: null,
  addOnCatalog: [],
  venues: [],
}

describe('ClientBillingPanel cancellation dialog accessibility', () => {
  afterEach(() => {
    cleanup()
    document.body.style.overflow = ''
  })

  it('contains focus, closes on Escape, and returns focus to its opener', async () => {
    mocks.overview.mockResolvedValue(overview)
    render(<ClientBillingPanel />)
    const opener = await screen.findByRole('button', { name: 'Cancel subscription' })
    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog', {
      name: 'Cancel at the end of your paid period?',
    })
    const reason = screen.getByRole('textbox', { name: 'Why are you canceling?' })
    await waitFor(() => expect(document.activeElement).toBe(reason))
    expect(dialog.getAttribute('aria-describedby')).toBe('cancel-billing-description')
    expect(document.body.style.overflow).toBe('hidden')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(opener))
    expect(document.body.style.overflow).toBe('')
  })
})
