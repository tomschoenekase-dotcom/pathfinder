'use client'

import { useMemo } from 'react'

import { DashboardOverviewView } from '../../../components/DashboardOverview'
import { SendInformation } from '../../../components/portal/SendInformation'
import { FixtureTRPCClientProvider } from '../../../lib/trpc'
import { createPortalFixtureClient } from '../client-portal/fixture-client'

const VENUE = { id: 'fixture-great-lakes-museum', name: 'Great Lakes Discovery Museum' }

export function PortalHomeFixture({ state }: { state: 'live' | 'paused' }) {
  const client = useMemo(
    () => createPortalFixtureClient({ payment: 'none', uploads: 'ok', send: 'ok', save: 'ok' }),
    [],
  )
  return (
    <FixtureTRPCClientProvider client={client}>
      <main data-fixture="portal-home" data-fixture-state={state}>
        <DashboardOverviewView
          venue={VENUE}
          venues={[VENUE]}
          guide={
            state === 'paused'
              ? { kind: 'paused' }
              : { kind: 'published', url: 'https://example.test/great-lakes-discovery-museum/chat' }
          }
          requests={[]}
          sendSection={<SendInformation venueId={VENUE.id} canSendLinksAndNotes />}
          paymentSection={null}
        />
      </main>
    </FixtureTRPCClientProvider>
  )
}
