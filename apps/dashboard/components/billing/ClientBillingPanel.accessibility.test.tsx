/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ clientState: vi.fn(), portal: vi.fn() }))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    billing: {
      clientState: { query: mocks.clientState },
      createPortal: { mutate: mocks.portal },
      requestCancellation: { mutate: vi.fn() },
    },
  }),
}))

import { ClientBillingPanel } from './ClientBillingPanel'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const state = {
  state: 'active',
  nextAction: 'manage_billing',
  asOf: new Date('2026-10-02T12:00:00Z'),
  lastReliableUpdateAt: new Date('2026-10-01T12:00:00Z'),
  reason: null,
  errorKind: null,
  accessState: 'ACTIVE',
  syncHealth: 'CURRENT',
  plan: {
    name: 'Torchiko Pilot',
    interval: 'month',
    intervalCount: 1,
    price: { amountMinor: 2500n, currency: 'usd' },
  },
  period: {
    currentPeriodEndsAt: new Date('2026-11-01T12:00:00Z'),
    paidThroughAt: null,
    graceEndsAt: null,
    accessEndsAt: null,
    expired: false,
  },
  amountDue: null,
  coveredVenues: [],
  invoices: [],
  actions: { canStartCheckout: false, checkoutUrl: null, canManageBilling: true, canCancel: true },
}

describe('ClientBillingPanel', () => {
  afterEach(() => {
    cleanup()
    document.body.style.overflow = ''
    mocks.clientState.mockReset()
    mocks.portal.mockReset()
  })

  it('contains focus in the cancellation dialog, closes on Escape, and returns focus', async () => {
    mocks.clientState.mockResolvedValue(state)
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

  it('uses a cancellable transport for the billing read and aborts it on unmount', async () => {
    let signal: AbortSignal | undefined
    mocks.clientState.mockImplementationOnce(
      (_input: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal
        return new Promise(() => undefined)
      },
    )
    const rendered = render(<ClientBillingPanel />)

    await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal))
    expect(signal?.aborted).toBe(false)
    expect(screen.getByRole('status').textContent).toContain('Loading billing')

    rendered.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('never renders a blank page: a no-setup tenant sees an explicit message', async () => {
    mocks.clientState.mockResolvedValue({
      ...state,
      state: 'no_setup',
      nextAction: 'contact_support',
      reason: 'no_billing_account',
      plan: null,
      period: null,
      lastReliableUpdateAt: null,
    })
    const { container } = render(<ClientBillingPanel />)
    expect(
      await screen.findByRole('heading', { name: 'Your Torchiko team has not set up billing yet' }),
    ).toBeTruthy()
    expect(container.textContent).toContain('No payment has been requested through this page')
  })

  it('shows a retry, not a blank or empty state, when the request fails', async () => {
    mocks.clientState.mockRejectedValueOnce(new Error('Temporary read failure'))
    mocks.clientState.mockResolvedValueOnce(state)
    render(<ClientBillingPanel />)

    expect(
      await screen.findByRole('heading', { name: 'We could not load your billing status' }),
    ).toBeTruthy()
    expect(screen.queryByText(/no subscription|nothing is due/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(mocks.clientState).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('heading', { name: 'Your subscription is active' })).toBeTruthy()
  })

  it('renders a server-returned error state with retry', async () => {
    mocks.clientState.mockResolvedValue({ ...state, state: 'error', errorKind: 'configuration' })
    render(<ClientBillingPanel />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('not configured correctly')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('maps a FORBIDDEN response to the forbidden state', async () => {
    mocks.clientState.mockRejectedValue(
      Object.assign(new Error('no'), { data: { code: 'FORBIDDEN' } }),
    )
    render(<ClientBillingPanel />)
    expect(
      await screen.findByRole('heading', { name: 'Billing is visible to managers and owners' }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('shows a visible error if opening billing management fails', async () => {
    mocks.clientState.mockResolvedValue(state)
    mocks.portal.mockRejectedValue(new Error('Portal unavailable'))
    render(<ClientBillingPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Manage billing' }))
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toContain('Portal unavailable')
  })
})
