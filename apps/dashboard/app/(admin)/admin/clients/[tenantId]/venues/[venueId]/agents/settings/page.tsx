import Link from 'next/link'

import { env } from '@pathfinder/config'

export default async function AgentSettingsPage({
  params,
}: {
  params: Promise<{ tenantId: string; venueId: string }>
}) {
  const { tenantId, venueId } = await params
  const agentBase = `/admin/clients/${tenantId}/venues/${venueId}/agents`
  const aiConfiguration = `/admin/clients/${tenantId}/venues/${venueId}/ai-configuration`
  return (
    <div className="space-y-8">
      <header className="border-b border-pf-light pb-6">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Agent workspace / controls
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          AI controls and safety boundaries
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/65">
          Control model routing, budgets, specialist authority, and execution readiness without
          mixing provider authentication with application data.
        </p>
      </header>
      <section className="grid gap-4 md:grid-cols-2">
        <ControlCard
          title="Execution runtime"
          status={env.AGENT_RUNNER_ENABLED ? 'Enabled' : 'Paused'}
          detail="The managed AgentRun worker is feature-gated. Paused means tasks remain durable and queued; it does not mean they ran."
        />
        <ControlCard
          title="Approvals"
          status="Enforced"
          detail="Answering an agent question and approving a risky action are separate operations with separate evidence."
        />
        <ControlCard
          title="Subscription bridges"
          status={env.AGENT_BRIDGE_HTTP_ENABLED ? 'HTTP admitted' : 'HTTP paused'}
          detail="Hermes, Claude subscription, Codex subscription, and local models execute only through short-lived, venue-scoped runner sessions."
        />
        <ControlCard
          title="Durability"
          status="Lease protected"
          detail="Claims, heartbeats, cancellation, retries, attempt limits, lineage, messages, artifacts, and costs are persisted."
        />
      </section>
      <section className="rounded-3xl border border-pf-light bg-white p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-pf-deep">Configure</h3>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href={`${agentBase}#team`}
            className="rounded-2xl bg-pf-primary px-5 py-3 text-sm font-semibold text-white"
          >
            Specialist roles and models
          </Link>
          <Link
            href={aiConfiguration}
            className="rounded-2xl border border-pf-light px-5 py-3 text-sm font-semibold text-pf-primary"
          >
            Workload models and budgets
          </Link>
          <Link
            href={`${agentBase}/integrations`}
            className="rounded-2xl border border-pf-light px-5 py-3 text-sm font-semibold text-pf-primary"
          >
            Runner connections
          </Link>
        </div>
      </section>
    </div>
  )
}

function ControlCard({ title, status, detail }: { title: string; status: string; detail: string }) {
  return (
    <article className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm">
      <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/50">{title}</p>
      <p className="mt-2 text-lg font-semibold text-pf-deep">{status}</p>
      <p className="mt-2 text-sm leading-6 text-pf-deep/65">{detail}</p>
    </article>
  )
}
