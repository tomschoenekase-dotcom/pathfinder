/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('../billing/ClientBillingPanel', () => ({
  ClientBillingPanel: () => <p>Stripe account details</p>,
}))

import { BillingWorkspace } from './BillingWorkspace'

describe('BillingWorkspace', () => {
  afterEach(cleanup)

  it('shows the Stripe panel only when the billing capability is available', () => {
    const { rerender } = render(<BillingWorkspace enabled={false} />)
    expect(screen.getByRole('heading', { name: 'Billing' })).toBeTruthy()
    expect(screen.getByText(/not available for this organization/i)).toBeTruthy()
    expect(screen.queryByText('Stripe account details')).toBeNull()

    rerender(<BillingWorkspace enabled />)
    expect(screen.getByText('Stripe account details')).toBeTruthy()
  })
})
