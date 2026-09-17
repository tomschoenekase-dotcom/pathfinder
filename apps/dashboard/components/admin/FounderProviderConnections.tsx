import type { inferRouterOutputs } from '@trpc/server'
import Link from 'next/link'

import type { AppRouter } from '@pathfinder/api'

type Connections = inferRouterOutputs<AppRouter>['admin']['getFounderProviderConnections']
type Provider = Connections['sessions'][number]['provider']

const providers: ReadonlyArray<{
  id: Provider
  name: string
  description: string
}> = [
  {
    id: 'CODEX_SUBSCRIPTION',
    name: 'Codex',
    description: 'Local Codex subscription runner for bounded analysis, plans, and code review.',
  },
  {
    id: 'HERMES',
    name: 'Hermes',
    description: 'Named local Hermes profile for repeatable specialist workflows.',
  },
  {
    id: 'CLAUDE_SUBSCRIPTION',
    name: 'Claude',
    description: 'Local Claude subscription runner for plan-only reading and synthesis.',
  },
  {
    id: 'OPENAI_COMPATIBLE',
    name: 'Local models',
    description: 'Loopback OpenAI-compatible inference for private, single-task work.',
  },
]

function integrationHref(tenantId: string, venueId: string) {
  return `/admin/clients/${encodeURIComponent(tenantId)}/venues/${encodeURIComponent(venueId)}/agents/integrations`
}

export function FounderProviderConnections({
  connections,
  bridgeHttpEnabled,
}: {
  connections: Connections
  bridgeHttpEnabled: boolean
}) {
  const now = new Date()

  return (
    <section
      aria-labelledby="provider-connections-heading"
      className="border-y border-slate-200 py-6"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-800">
            Provider connections
          </p>
          <h2
            id="provider-connections-heading"
            className="mt-1 text-xl font-semibold text-slate-950"
          >
            Your local AI workers
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            A provider is connected only while its authenticated local runner is actively
            heartbeating. Torchiko never stores your Codex, Claude, or Hermes login.
          </p>
        </div>
        <span
          className={`w-fit text-sm font-semibold ${bridgeHttpEnabled ? 'text-emerald-700' : 'text-amber-800'}`}
        >
          {bridgeHttpEnabled ? 'Bridge admission enabled' : 'Bridge admission paused'}
        </span>
      </div>

      <div className="mt-5 grid gap-x-8 gap-y-5 md:grid-cols-2">
        {providers.map((provider) => {
          const matching = connections.sessions.filter(
            (session) => session.provider === provider.id,
          )
          const live = matching.filter(
            (session) => session.status === 'ONLINE' && session.expiresAt > now,
          )
          const latest = live[0] ?? matching[0]
          const label = live.length ? 'Connected' : matching.length ? 'Offline' : 'Not connected'
          const tone = live.length
            ? 'bg-emerald-500'
            : matching.length
              ? 'bg-slate-400'
              : 'bg-amber-400'

          return (
            <article key={provider.id} className="border-t border-slate-200 pt-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-slate-950">{provider.name}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{provider.description}</p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-2 text-xs font-bold text-slate-700">
                  <span className={`h-2.5 w-2.5 rounded-full ${tone}`} aria-hidden="true" />
                  {label}
                </span>
              </div>
              {latest ? (
                <div className="mt-3 text-xs leading-5 text-slate-600">
                  <p>
                    {latest.label} · {latest.tenant.name} / {latest.venue.name}
                  </p>
                  <p>Last seen {latest.lastHeartbeatAt.toLocaleString()}</p>
                  <Link
                    href={integrationHref(latest.tenantId, latest.venueId)}
                    className="mt-2 inline-flex min-h-11 items-center font-semibold text-sky-800 underline decoration-sky-300 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                  >
                    Open {provider.name} connection
                  </Link>
                </div>
              ) : (
                <p className="mt-3 text-xs leading-5 text-slate-600">
                  Choose a venue below to connect {provider.name}.
                </p>
              )}
            </article>
          )
        })}
      </div>

      <div className="mt-6 border-t border-slate-200 pt-5">
        <h3 className="text-sm font-semibold text-slate-950">Connect a provider to a venue</h3>
        {connections.venues.length ? (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            {connections.venues.map((venue) => (
              <Link
                key={`${venue.tenantId}:${venue.id}`}
                href={integrationHref(venue.tenantId, venue.id)}
                className="inline-flex min-h-11 items-center text-sm font-semibold text-sky-800 underline decoration-sky-300 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              >
                {venue.name}
                <span className="sr-only"> for {venue.tenant.name}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            No active venue is available for a provider connection.
          </p>
        )}
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Connections are venue-scoped so a local worker cannot silently gain access to every
          customer.
        </p>
      </div>
    </section>
  )
}
