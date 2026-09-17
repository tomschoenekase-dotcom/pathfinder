/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it } from 'vitest'

import { FounderProviderConnections } from './FounderProviderConnections'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('FounderProviderConnections', () => {
  afterEach(cleanup)

  it('distinguishes live, offline, and never-connected providers with venue setup links', async () => {
    const { container } = render(
      <FounderProviderConnections
        bridgeHttpEnabled
        connections={{
          sessions: [
            {
              id: 'session-1',
              tenantId: 'tenant one',
              venueId: 'venue/one',
              provider: 'CODEX_SUBSCRIPTION',
              label: "Tom's Codex PC",
              status: 'ONLINE',
              lastHeartbeatAt: new Date(),
              expiresAt: new Date(Date.now() + 60_000),
              tenant: { name: 'Torchiko QA' },
              venue: { name: 'Space Museum' },
            },
            {
              id: 'session-2',
              tenantId: 'tenant-1',
              venueId: 'venue-2',
              provider: 'HERMES',
              label: 'Hermes desktop',
              status: 'OFFLINE',
              lastHeartbeatAt: new Date('2026-09-17T12:00:00.000Z'),
              expiresAt: new Date('2026-09-17T12:02:00.000Z'),
              tenant: { name: 'Torchiko QA' },
              venue: { name: 'Mini Museum' },
            },
          ],
          venues: [
            {
              id: 'venue/one',
              tenantId: 'tenant one',
              name: 'Space Museum',
              tenant: { name: 'Torchiko QA' },
            },
          ],
        }}
      />,
    )

    expect(screen.getByText('Bridge admission enabled')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('Offline')).toBeTruthy()
    expect(screen.getAllByText('Not connected')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Open Codex connection' }).getAttribute('href')).toBe(
      '/admin/clients/tenant%20one/venues/venue%2Fone/agents/integrations',
    )
    expect(screen.getByRole('link', { name: /Space Museum/ })).toBeTruthy()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
