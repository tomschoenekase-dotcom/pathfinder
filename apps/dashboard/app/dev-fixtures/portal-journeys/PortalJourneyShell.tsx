'use client'

import type { ReactNode } from 'react'

import { DashboardShellView } from '../../../components/DashboardShell'
import { TRPCProvider } from '../../../lib/trpc'

export function PortalJourneyShell({
  venueId,
  state,
  children,
}: {
  venueId: string
  state: string
  children: ReactNode
}) {
  return (
    <TRPCProvider scopeKey={`fixture:portal-journeys:${state}`}>
      <div data-fixture="portal-journeys" data-fixture-state={state}>
        <DashboardShellView
          pathname="/"
          selectedVenueId={venueId}
          orgName="Maple Hollow Nature Center"
          isPlatformAdmin={false}
          weeklyReportsAvailable
          routeKey={`/?venue=${venueId}&state=${state}`}
          signOutControl={<button type="button">Sign out</button>}
        >
          {children}
        </DashboardShellView>
      </div>
    </TRPCProvider>
  )
}
