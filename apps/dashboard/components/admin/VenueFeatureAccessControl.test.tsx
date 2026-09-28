/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.hoisted(() => vi.fn())
const queryUsage = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      setProductEntitlementOverride: { mutate },
      getVenueVoiceUsageSummary: { query: queryUsage },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { VenueFeatureAccessControl } from './VenueFeatureAccessControl'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const entitlements = [
  {
    capability: 'voice',
    enabled: true,
    source: 'PLAN',
    sourceId: null,
    planTier: 'launch',
    settings: {},
    validUntil: null,
  },
  {
    capability: 'premium-voice',
    enabled: false,
    source: 'DEFAULT',
    sourceId: null,
    planTier: 'launch',
    settings: {},
    validUntil: null,
  },
]
const voiceUsage = {
  month: '2026-09',
  durationSeconds: 600,
  minutes: 10,
  sessionCount: 2,
  estimatedCostUsd: '0.12000000',
  estimatedCostPerMinuteUsd: '0.01200000',
  costIsEstimate: true,
  durationAttribution: 'voiceSession.connectedAt UTC-month overlap',
  costAttribution: 'AiUsageEvent.createdAt',
} as const

describe('VenueFeatureAccessControl', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mutate.mockResolvedValue({ id: 'grant-1' })
    queryUsage.mockResolvedValue(voiceUsage)
  })
  afterEach(cleanup)

  it('explains the two-key boundary and keeps submission confirmation-gated', () => {
    render(
      <VenueFeatureAccessControl
        tenantId="tenant-1"
        venueId="venue-1"
        venueName="QA Venue"
        entitlements={entitlements as never}
        initialVoiceUsage={voiceUsage as never}
      />,
    )

    expect(screen.getByText('Two-key activation')).toBeTruthy()
    expect(screen.getByText('No active cap')).toBeTruthy()
    expect(screen.getByText('Default grant setting: 300 min')).toBeTruthy()
    expect(screen.getByText(/never starts a provider session/i)).toBeTruthy()
    expect(screen.getByText(/No plan, invoice, or provider gate is changed/i)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Append Premium voice grant' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('appends an exact-scoped, expiring grant with bounded canary settings', async () => {
    render(
      <VenueFeatureAccessControl
        tenantId="tenant-1"
        venueId="venue-1"
        venueName="QA Venue"
        entitlements={entitlements as never}
        initialVoiceUsage={voiceUsage as never}
      />,
    )
    fireEvent.change(screen.getByLabelText('Audit reason'), {
      target: { value: 'Founder-governed synthetic staging Voice canary' },
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Append Premium voice grant' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        capability: 'premium-voice',
        effect: 'GRANT',
        kind: 'ADMIN',
        settings: {
          maxSessionSeconds: 600,
          dailySeconds: 3600,
          monthlySeconds: 18000,
          maxConcurrentSessions: 2,
          voice: 'marin',
        },
        reason: 'Founder-governed synthetic staging Voice canary',
      }),
    )
    expect(mutate.mock.calls[0]?.[0].endsAt).toMatch(/Z$/)
    expect(await screen.findByText(/runtime gate remains separate/i)).toBeTruthy()
    expect(refresh).toHaveBeenCalled()
  })

  it('shows bounded monthly usage and reloads only the selected month', async () => {
    render(
      <VenueFeatureAccessControl
        tenantId="tenant-1"
        venueId="venue-1"
        venueName="QA Venue"
        entitlements={entitlements as never}
        initialVoiceUsage={voiceUsage as never}
      />,
    )
    expect(screen.getByText('Client-reported cost per minute')).toBeTruthy()
    expect(screen.getByText(/unverified estimates, not an invoice/i)).toBeTruthy()
    expect(screen.getByText('$0.0120')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-08' } })
    await waitFor(() =>
      expect(queryUsage).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          month: '2026-08',
        },
        { signal: expect.any(AbortSignal) },
      ),
    )
  })

  it('keeps entitlement controls available when usage is unavailable', async () => {
    queryUsage.mockRejectedValue(new Error('summary unavailable'))
    render(
      <VenueFeatureAccessControl
        tenantId="tenant-1"
        venueId="venue-1"
        venueName="QA Venue"
        entitlements={entitlements as never}
        initialVoiceUsage={null}
      />,
    )

    expect(
      screen.getByText('Usage summary is unavailable. Feature access controls remain available.'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Append Premium voice grant' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-08' } })
    await screen.findByText(
      'Usage summary is unavailable. Feature access controls remain available.',
    )
    expect(screen.getByRole('button', { name: 'Append Premium voice grant' })).toBeTruthy()
    expect(queryUsage).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        month: '2026-08',
      },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('shows the active entitlement cap instead of the default when configured', () => {
    render(
      <VenueFeatureAccessControl
        tenantId="tenant-1"
        venueId="venue-1"
        venueName="QA Venue"
        entitlements={
          [
            ...entitlements.slice(0, 1),
            { ...entitlements[1], enabled: true, settings: { monthlySeconds: 7200 } },
          ] as never
        }
        initialVoiceUsage={voiceUsage as never}
      />,
    )
    expect(screen.getByText('120 min')).toBeTruthy()
    expect(screen.getByText('From the effective Premium voice entitlement')).toBeTruthy()
  })

  it('shows tiny cost estimates without rounding them to zero', () => {
    render(
      <VenueFeatureAccessControl
        tenantId="tenant-1"
        venueId="venue-1"
        venueName="QA Venue"
        entitlements={entitlements as never}
        initialVoiceUsage={
          {
            ...voiceUsage,
            estimatedCostUsd: '0.00000025',
            estimatedCostPerMinuteUsd: '0.00000025',
          } as never
        }
      />,
    )
    expect(screen.getAllByText('$0.00000025')).toHaveLength(2)
  })
})
