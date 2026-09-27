import { notFound } from 'next/navigation'

import { AdminVenueDistributionPanel } from '../../../components/admin/AdminVenueDistributionPanel'
import { TRPCProvider } from '../../../lib/trpc'

export default function VisitorAccessVisualFixture() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <main data-fixture="visitor-access" className="mx-auto max-w-6xl space-y-7 p-4 sm:p-6">
      <header className="space-y-3">
        <p className="text-sm font-medium text-pf-primary">
          Client administration / Great Lakes Discovery Museum
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Visitor access</h1>
        <p className="text-sm leading-6 text-pf-deep/70">
          Review visitor entry points, website framing origins, app access, and recent sessions.
        </p>
      </header>
      <TRPCProvider scopeKey="visitor-access-visual-fixture">
        <AdminVenueDistributionPanel
          tenantId="fixture-tenant"
          venueId="fixture-venue"
          website={{
            state: 'ENABLED',
            effective: true,
            reason: null,
            framed: true,
            frameReason: null,
          }}
          app={{ state: 'ENABLED', effective: true, reason: null }}
          revision={7}
          origins={[
            {
              id: 'fixture-origin-1',
              origin: 'https://greatlakesmuseum.example',
              state: 'ACTIVE',
              addedReason: 'Museum visitor guide',
              addedAt: '2026-09-20T14:00:00.000Z',
              revokedReason: null,
              revokedAt: null,
            },
            {
              id: 'fixture-origin-2',
              origin: 'https://tickets.greatlakesmuseum.example',
              state: 'ACTIVE',
              addedReason: 'Ticketing page',
              addedAt: '2026-09-21T14:00:00.000Z',
              revokedReason: null,
              revokedAt: null,
            },
            {
              id: 'fixture-origin-3',
              origin: 'https://old-greatlakesmuseum.example',
              state: 'REVOKED',
              addedReason: 'Previous website',
              addedAt: '2026-08-20T14:00:00.000Z',
              revokedReason: 'Website moved',
              revokedAt: '2026-09-01T14:00:00.000Z',
            },
          ]}
          sessions30d={{ direct: 24, qr: 86, website: 142, app: 39, unknown: 2 }}
          previewUrl="https://guide.example/great-lakes-discovery-museum"
          artifacts={[
            {
              label: 'Public visitor URL',
              value: 'https://guide.example/great-lakes-discovery-museum',
            },
            { label: 'QR entry URL', value: 'https://guide.example/great-lakes-discovery-museum' },
            {
              label: 'Launcher snippet',
              value: '<script src="https://guide.example/widget.js"></script>',
            },
            {
              label: 'Inline snippet',
              value: '<div data-torchiko-inline="great-lakes-discovery-museum"></div>',
            },
            { label: 'App URL', value: 'https://guide.example/app/great-lakes-discovery-museum' },
            {
              label: 'Compact app URL',
              value: 'https://guide.example/app/great-lakes-discovery-museum?header=compact',
            },
            { label: 'App background color', value: '#F2F5F9' },
          ]}
          proposals={[
            {
              approvalRequestId: 'fixture-proposal-1',
              reason: 'Add the new ticketing host requested by the venue owner.',
              createdAt: '2026-09-25T14:00:00.000Z',
              expectedRevision: 7,
              change: {
                kind: 'ADD_ORIGIN',
                origin: 'https://new-tickets.greatlakesmuseum.example',
              },
            },
          ]}
        />
      </TRPCProvider>
    </main>
  )
}
