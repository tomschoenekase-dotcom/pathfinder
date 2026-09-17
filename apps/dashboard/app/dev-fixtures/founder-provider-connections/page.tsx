import { FounderProviderConnections } from '../../../components/admin/FounderProviderConnections'

export default function FounderProviderConnectionsFixturePage() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-6xl bg-white px-4 py-6 shadow-sm sm:px-8">
        <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
          Founder Control Room fixture
        </p>
        <FounderProviderConnections
          bridgeHttpEnabled
          connections={{
            sessions: [
              {
                id: 'fixture-codex-session',
                tenantId: 'fixture-tenant',
                venueId: 'fixture-space-museum',
                provider: 'CODEX_SUBSCRIPTION',
                label: "Tom's Codex PC",
                status: 'ONLINE',
                lastHeartbeatAt: new Date('2099-09-17T14:28:00.000Z'),
                expiresAt: new Date('2099-09-17T14:30:00.000Z'),
                tenant: { name: 'Torchiko Staging' },
                venue: { name: 'Space Museum' },
              },
              {
                id: 'fixture-hermes-session',
                tenantId: 'fixture-tenant',
                venueId: 'fixture-mini-museum',
                provider: 'HERMES',
                label: 'Hermes desktop',
                status: 'OFFLINE',
                lastHeartbeatAt: new Date('2026-09-16T17:15:00.000Z'),
                expiresAt: new Date('2026-09-16T17:17:00.000Z'),
                tenant: { name: 'Torchiko Staging' },
                venue: { name: 'Mini Museum' },
              },
            ],
            venues: [
              {
                id: 'fixture-mini-museum',
                tenantId: 'fixture-tenant',
                name: 'Mini Museum',
                tenant: { name: 'Torchiko Staging' },
              },
              {
                id: 'fixture-space-museum',
                tenantId: 'fixture-tenant',
                name: 'Space Museum',
                tenant: { name: 'Torchiko Staging' },
              },
            ],
          }}
        />
      </div>
    </main>
  )
}
