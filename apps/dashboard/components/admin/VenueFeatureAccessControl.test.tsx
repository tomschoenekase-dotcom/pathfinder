/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { setProductEntitlementOverride: { mutate } } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { VenueFeatureAccessControl } from './VenueFeatureAccessControl'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const entitlements = [
  {
    capability: 'voice',
    enabled: false,
    source: 'DEFAULT',
    sourceId: null,
    planTier: 'launch',
    settings: {},
    validUntil: null,
  },
]

describe('VenueFeatureAccessControl', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mutate.mockResolvedValue({ id: 'grant-1' })
  })
  afterEach(cleanup)

  it('explains the two-key boundary and keeps submission confirmation-gated', () => {
    render(
      <VenueFeatureAccessControl
        tenantId="tenant-1"
        venueId="venue-1"
        venueName="QA Venue"
        entitlements={entitlements as never}
      />,
    )

    expect(screen.getByText('Two-key activation')).toBeTruthy()
    expect(screen.getByText(/never starts a provider session/i)).toBeTruthy()
    expect(screen.getByText(/No plan, invoice, or provider gate is changed/i)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Append Voice grant' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('appends an exact-scoped, expiring grant with bounded canary settings', async () => {
    render(
      <VenueFeatureAccessControl
        tenantId="tenant-1"
        venueId="venue-1"
        venueName="QA Venue"
        entitlements={entitlements as never}
      />,
    )
    fireEvent.change(screen.getByLabelText('Audit reason'), {
      target: { value: 'Founder-governed synthetic staging Voice canary' },
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Append Voice grant' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        capability: 'voice',
        effect: 'GRANT',
        kind: 'ADMIN',
        settings: {
          maxSessionSeconds: 120,
          dailySeconds: 300,
          monthlySeconds: 900,
          maxConcurrentSessions: 1,
          voice: 'marin',
        },
        reason: 'Founder-governed synthetic staging Voice canary',
      }),
    )
    expect(mutate.mock.calls[0]?.[0].endsAt).toMatch(/Z$/)
    expect(await screen.findByText(/runtime gate remains unchanged/i)).toBeTruthy()
    expect(refresh).toHaveBeenCalled()
  })
})
