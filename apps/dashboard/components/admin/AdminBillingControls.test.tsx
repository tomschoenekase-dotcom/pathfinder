/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkout: vi.fn(),
  manual: vi.fn(),
  override: vi.fn(),
  setFlag: vi.fn(),
}))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      createClientCheckout: { mutate: mocks.checkout },
      createManualArrangement: { mutate: mocks.manual },
      createBillingAccessOverride: { mutate: mocks.override },
      setBillingTenantFlag: { mutate: mocks.setFlag },
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
        rolloutFlags={[]}
      />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'Use an approved negotiated total' }))
    fireEvent.change(screen.getByLabelText(/Total in USD cents/i), { target: { value: '3750' } })
    fireEvent.change(screen.getByLabelText('Museum A negotiated amount in USD cents'), {
      target: { value: '3750' },
    })
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
          venueAmounts: [{ venueId: 'venue-a', amountMinor: '3750' }],
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
        rolloutFlags={[]}
      />,
    )

    fireEvent.submit(screen.getByRole('button', { name: 'Create Checkout link' }).closest('form')!)
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledTimes(1))
    expect(mocks.checkout.mock.calls[0]?.[0]).not.toHaveProperty('negotiatedTerms')
  })

  it('keeps a multi-venue quote disabled until every component reconciles to the total', () => {
    render(
      <AdminBillingControls
        tenantId="tenant-a"
        venues={[
          { id: 'venue-a', name: 'Museum A' },
          { id: 'venue-b', name: 'Museum B' },
        ]}
        catalog={[{ key: 'torchiko_pilot_test', version: 1, displayName: 'Pilot test' }]}
        agreementId={null}
        hasManualBase={false}
        rolloutFlags={[]}
      />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'Use an approved negotiated total' }))
    fireEvent.change(screen.getByLabelText(/Total in USD cents/i), { target: { value: '5000' } })
    fireEvent.change(screen.getByLabelText('Museum A negotiated amount in USD cents'), {
      target: { value: '3000' },
    })
    fireEvent.change(screen.getByLabelText('Museum B negotiated amount in USD cents'), {
      target: { value: '1999' },
    })
    fireEvent.change(screen.getByLabelText('Agreement or quote reference'), {
      target: { value: 'QUOTE-MULTI' },
    })
    fireEvent.change(screen.getByLabelText('Pricing reason'), {
      target: { value: 'Founder-approved multi-venue quote' },
    })
    expect(
      (screen.getByRole('button', { name: 'Create Checkout link' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    fireEvent.change(screen.getByLabelText('Museum B negotiated amount in USD cents'), {
      target: { value: '2000' },
    })
    expect(screen.getByText('Venue components match the approved total.')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Create Checkout link' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('changes only an allowlisted client rollout capability through the audited admin mutation', async () => {
    mocks.setFlag.mockResolvedValue({ enabled: true, globalEnabled: true, effective: true })
    render(
      <AdminBillingControls
        tenantId="tenant-a"
        venues={[{ id: 'venue-a', name: 'Museum A' }]}
        catalog={[{ key: 'torchiko_pilot_test', version: 1, displayName: 'Pilot test' }]}
        agreementId={null}
        hasManualBase={false}
        rolloutFlags={[
          {
            tenantFlagKey: 'billing-ui-v1',
            label: 'Payment tab',
            description: 'Shows billing.',
            globalEnabled: true,
            tenantEnabled: false,
            effective: false,
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    await waitFor(() =>
      expect(mocks.setFlag).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        flagKey: 'billing-ui-v1',
        enabled: true,
      }),
    )
    expect(await screen.findByText('Enabled for this client')).toBeTruthy()
  })
})
