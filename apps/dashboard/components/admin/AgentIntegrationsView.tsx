import Link from 'next/link'

import { AgentBridgeSessionControl } from './AgentBridgeSessionControl'

type Session = {
  id: string
  provider: string
  label: string
  runnerVersion: string
  supportedModels: string[]
  status: string
  lastHeartbeatAt: Date
  expiresAt: Date
  _count: { agentRuns: number }
}

type Identity = {
  id: string
  name: string
  agentType: string
  defaultProvider: string | null
  defaultModel: string | null
  enabled: boolean
}

const providers = [
  [
    'HERMES',
    'Hermes',
    'hermes-bridge',
    'Named specialist personalities and repeatable workflows.',
    'ACP analysis mode; every tool permission request is denied by the bounded runner.',
  ],
  [
    'CLAUDE_SUBSCRIPTION',
    'Claude subscription',
    'claude-bridge',
    'Deep reading, synthesis, critique, and planning.',
    'Plan-only with no tools and no persisted CLI session.',
  ],
  [
    'CODEX_SUBSCRIPTION',
    'Codex subscription',
    'codex-bridge',
    'Repository analysis, implementation plans, and code review.',
    'Ephemeral read-only sandbox with approvals disabled.',
  ],
  [
    'OPENAI_COMPATIBLE',
    'Local / compatible',
    'openai-compatible-bridge',
    'Private drafts, classification, and patient background analysis.',
    'Loopback inference only; one leased task at a time and no invented cost.',
  ],
] as const

export function AgentIntegrationsView({
  tenantId,
  venueId,
  sessions,
  identities,
  agentRunnerEnabled,
  bridgeHttpEnabled = false,
}: {
  tenantId: string
  venueId: string
  sessions: Session[]
  identities: Identity[]
  agentRunnerEnabled: boolean
  bridgeHttpEnabled?: boolean
}) {
  const now = new Date()
  const base = `/admin/clients/${tenantId}/venues/${venueId}/agents`
  return (
    <div className="space-y-8">
      <header className="border-b border-pf-light pb-6">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Agent workspace / integrations
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          AI integration control room
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/65">
          See which execution surfaces are truly reachable, which specialists use them, and when a
          runner last proved that it was alive. This page stores no provider or subscription secret.
        </p>
        <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
          {bridgeHttpEnabled
            ? 'Bridge HTTP admission is enabled. A runner is usable only while an activated credential verifies and its short-lived session heartbeat remains online.'
            : 'Bridge HTTP admission is paused. Machine credentials start disabled, and provider assignment alone cannot authenticate or make a runner appear online.'}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href={base}
            className="rounded-full border border-pf-light px-4 py-2 text-sm font-semibold text-pf-primary"
          >
            Back to workspace
          </Link>
          <Link
            href={`${base}/settings`}
            className="rounded-full border border-pf-light px-4 py-2 text-sm font-semibold text-pf-primary"
          >
            AI controls
          </Link>
          <Link
            href={`/admin/clients/${tenantId}/credentials`}
            className="rounded-full border border-pf-light px-4 py-2 text-sm font-semibold text-pf-primary"
          >
            Machine credentials
          </Link>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Provider status">
        <ProviderCard
          name="Claude API worker"
          provider="anthropic"
          online={agentRunnerEnabled}
          identities={identities}
          detail="Managed, budget-admitted execution in the durable worker."
          bestFor="Fast production text work with explicit API budgets and usage evidence."
          authority="Server-managed text generation; no agent tools or hidden external actions."
        />
        <ProviderCard
          name="Bridge HTTP admission"
          provider="agent-bridge-http"
          online={bridgeHttpEnabled}
          identities={[]}
          bestFor="Admitting authenticated desktop workers into the durable run lifecycle."
          authority="Transport only; exact active credential, venue scope, and live lease required."
          detail={
            bridgeHttpEnabled
              ? 'The authenticated endpoint is admitted; credential and session checks still apply.'
              : 'The public endpoint returns not found before authentication while the rollout gate is off.'
          }
        />
        {providers.map(([bridgeProvider, name, identityProvider, bestFor, authority]) => {
          const matching = sessions.filter((session) => session.provider === bridgeProvider)
          const online = matching.some(
            (session) => session.status === 'ONLINE' && session.expiresAt > now,
          )
          return (
            <ProviderCard
              key={bridgeProvider}
              name={name}
              provider={identityProvider}
              online={online}
              identities={identities}
              bestFor={bestFor}
              authority={authority}
              detail={
                online
                  ? `${matching.filter((session) => session.status === 'ONLINE' && session.expiresAt > now).length} live runner session(s).`
                  : 'A verified local runner must register and keep heartbeating.'
              }
            />
          )
        })}
      </section>

      <section className="rounded-3xl border border-pf-light bg-white p-6 shadow-sm">
        <h3 className="text-xl font-semibold text-pf-deep">Runner sessions</h3>
        <p className="mt-1 text-sm text-pf-deep/60">
          Presence expires after two minutes. Disconnecting is audited and prevents future task
          claims; a leased task still relies on its own bounded timeout and retry policy.
        </p>
        {sessions.length ? (
          <ul className="mt-5 divide-y divide-pf-light">
            {sessions.map((session) => {
              const online = session.status === 'ONLINE' && session.expiresAt > now
              return (
                <li
                  key={session.id}
                  className="flex flex-wrap items-start justify-between gap-4 py-4"
                >
                  <div>
                    <p className="font-semibold text-pf-deep">{session.label}</p>
                    <p className="mt-1 text-xs text-pf-deep/55">
                      {session.provider.replace(/_/g, ' ')} · {session.runnerVersion} ·{' '}
                      {session._count.agentRuns} claimed runs
                    </p>
                    <p className="mt-1 text-xs text-pf-deep/50">
                      {session.supportedModels.length
                        ? session.supportedModels.join(' · ')
                        : 'Any configured model'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={`text-sm font-semibold ${online ? 'text-emerald-700' : 'text-slate-500'}`}
                    >
                      {online
                        ? 'Online now'
                        : session.status === 'REVOKED'
                          ? 'Disconnected'
                          : 'Offline'}
                    </p>
                    <p className="mt-1 text-xs text-pf-deep/50">
                      Last heartbeat {session.lastHeartbeatAt.toLocaleString()}
                    </p>
                    <AgentBridgeSessionControl
                      tenantId={tenantId}
                      venueId={venueId}
                      sessionId={session.id}
                      revoked={session.status === 'REVOKED'}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="mt-5 rounded-2xl border border-dashed border-pf-light p-5 text-sm text-pf-deep/60">
            No runner has registered. Configuring an identity does not authenticate a provider.
          </p>
        )}
      </section>
    </div>
  )
}

function ProviderCard({
  name,
  provider,
  online,
  identities,
  detail,
  bestFor,
  authority,
}: {
  name: string
  provider: string
  online: boolean
  identities: Identity[]
  detail: string
  bestFor: string
  authority: string
}) {
  const assigned = identities.filter((identity) => identity.defaultProvider === provider)
  return (
    <article className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold text-pf-deep">{name}</h3>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${online ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-950'}`}
        >
          {online ? 'Ready' : 'Unavailable'}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-pf-deep/65">{detail}</p>
      <dl className="mt-4 space-y-3 rounded-2xl bg-pf-surface/60 p-3 text-xs leading-5">
        <div>
          <dt className="font-bold uppercase tracking-[0.12em] text-pf-deep/45">Best for</dt>
          <dd className="mt-1 text-pf-deep/70">{bestFor}</dd>
        </div>
        <div>
          <dt className="font-bold uppercase tracking-[0.12em] text-pf-deep/45">
            Current authority
          </dt>
          <dd className="mt-1 text-pf-deep/70">{authority}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs font-semibold text-pf-deep/55">
        {assigned.length
          ? `${assigned.length} assigned: ${assigned.map((identity) => identity.name).join(', ')}`
          : 'No specialists assigned'}
      </p>
      <p className="mt-2 font-mono text-xs text-pf-deep/45">{provider}</p>
    </article>
  )
}
