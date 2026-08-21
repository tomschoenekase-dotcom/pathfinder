/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkout: vi.fn(),
  manual: vi.fn(),
  override: vi.fn(),
}))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      createClientCheckout: { mutate: mocks.checkout },
      createManualArrangement: { mutate: mocks.manual },
      createBillingAccessOverride: { mutate: mocks.override },
    },
  }),
}))

import { AdminBillingControls } from './AdminBillingControls'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('AdminBillingControls negotiated Checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkout.mockResolvedValue({ url: null })
  })

  afterEach(cleanup)

  it('sends an audited negotiated total only through the platform-admin action', async () => {
    render(
      <AdminBillingControls
        tenantId="tenant-a"
        venues={[{ id: 'venue-a', name: 'Museum A' }]}
        catalog={[{ key: 'torchiko_pilot_test', version: 1, displayName: 'Pilot test' }]}
        agreementId={null}
        hasManualBase={false}
      />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'Use an approved negotiated total' }))
    fireEvent.change(screen.getByLabelText(/Total in USD cents/i), { target: { value: '3750' } })
    fireEvent.change(screen.getByLabelText('Agreement or quote reference'), {
      target: { value: 'QUOTE-2026-0042' },
    })
    fireEvent.change(screen.getByLabelText('Pricing reason'), {
      target: { value: 'Approved pilot scope for two covered collections' },
    })
    fireEvent.submit(screen.getByRole('button', { name: 'Create Checkout link' }).closest('form')!)

    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledTimes(1))
    expect(mocks.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        planKey: 'torchiko_pilot_test',
        venueIds: ['venue-a'],
        negotiatedTerms: {
          amountMinor: '3750',
          currency: 'usd',
          interval: 'month',
          intervalCount: 1,
          reason: 'Approved pilot scope for two covered collections',
          reference: 'QUOTE-2026-0042',
        },
      }),
    )
  })

  it('keeps the ordinary Checkout request free of browser-supplied amounts', async () => {
    render(
      <AdminBillingControls
        tenantId="tenant-a"
        venues={[{ id: 'venue-a', name: 'Museum A' }]}
        catalog={[{ key: 'torchiko_pilot_test', version: 1, displayName: 'Pilot test' }]}
        agreementId={null}
        hasManualBase={false}
      />,
    )

    fireEvent.submit(screen.getByRole('button', { name: 'Create Checkout link' }).closest('form')!)
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledTimes(1))
    expect(mocks.checkout.mock.calls[0]?.[0]).not.toHaveProperty('negotiatedTerms')
  })
})
