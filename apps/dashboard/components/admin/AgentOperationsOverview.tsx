import Link from 'next/link'
import type { ReactNode } from 'react'
import { AgentIdentityConfigurationFields } from '@pathfinder/contracts'

import { ApprovalDecisionForm } from './ApprovalDecisionForm'
import { AgentIdentityCreateEditor, AgentIdentityEditEditor } from './AgentIdentityEditor'

type Cursor = { createdAt: string; id: string } | null

type Identity = {
  id: string
  identityKey: string
  name: string
  description: string | null
  agentType: string
  accessScope: string
  accessCapabilities: string[]
  autonomyLevel: string
  autonomousActions: string[]
  defaultProvider: string | null
  defaultModel: string | null
  enabled: boolean
  updatedAt: Date
  _count: { runs: number; approvalRequests: number }
}

type Run = {
  id: string
  runType: string
  requestedOperation: string
  status: string
  modelProvider: string | null
  modelName: string | null
  costE8Usd: bigint
  errorCode: string | null
  createdAt: Date
  agentIdentity: { id: string; name: string; enabled: boolean }
  _count: { actions: number; timelineEvents: number; approvalRequests: number }
}

type Approval = {
  id: string
  agentRunId: string | null
  proposedAction: string
  reason: string
  riskCategory: string
  state: string
  createdAt: Date
  agentIdentity: { id: string; name: string }
}

type Props = {
  tenantId: string
  venueId: string
  identities: { items: Identity[]; nextCursor: Cursor }
  runs: { items: Run[]; nextCursor: Cursor }
  approvals: { items: Approval[]; nextCursor: Cursor }
}

export function formatE8Usd(value: bigint) {
  const units = 100_000_000n
  const dollars = value / units
  const fractional = (value % units).toString().padStart(8, '0').replace(/0+$/, '')
  return `$${dollars.toString()}${fractional ? `.${fractional}` : '.00'}`
}

function cursorHref(base: string, prefix: string, cursor: Exclude<Cursor, null>) {
  return `${base}?${prefix}CreatedAt=${encodeURIComponent(cursor.createdAt)}&${prefix}Id=${encodeURIComponent(cursor.id)}`
}

function Badge({
  children,
  tone = 'slate',
}: {
  children: ReactNode
  tone?: 'slate' | 'green' | 'amber' | 'rose'
}) {
  const tones = {
    slate: 'bg-slate-100 text-slate-800',
    green: 'bg-emerald-100 text-emerald-900',
    amber: 'bg-amber-100 text-amber-950',
    rose: 'bg-rose-100 text-rose-900',
  }
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  )
}

export function AgentOperationsOverview({ tenantId, venueId, identities, runs, approvals }: Props) {
  const base = `/admin/clients/${tenantId}/venues/${venueId}/agents`
  return (
    <div className="space-y-8">
      <header className="border-b border-pf-light pb-6">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Agent operations
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          Control-plane evidence
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/65">
          Read-only identities, execution lifecycle, and approval state. Access describes where an
          agent may act; autonomy describes how independently it may act.
        </p>
        <p className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
          This view cannot enable, run, retry, or cancel an agent. Approval decisions record
          evidence only and never execute the proposed action.
        </p>
      </header>

      <section className="space-y-4" aria-labelledby="agent-identities-heading">
        <div>
          <h3 id="agent-identities-heading" className="text-xl font-semibold text-pf-deep">
            Agent identities
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Configured authority and operating boundaries.
          </p>
        </div>
        <AgentIdentityCreateEditor tenantId={tenantId} venueId={venueId} />
        {identities.items.length === 0 ? (
          <Empty text="No agent identities are configured for this venue." />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {identities.items.map((identity) => (
              <article
                key={identity.id}
                className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold text-pf-deep">{identity.name}</h4>
                    <p className="mt-1 font-mono text-xs text-pf-deep/55">{identity.identityKey}</p>
                  </div>
                  <Badge tone={identity.enabled ? 'green' : 'slate'}>
                    {identity.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </div>
                {identity.description ? (
                  <p className="mt-3 text-sm leading-6 text-pf-deep/65">{identity.description}</p>
                ) : null}
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-pf-light bg-pf-surface/50 p-3">
                    <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/55">
                      Access scope
                    </p>
                    <p className="mt-1 font-semibold text-pf-deep">
                      {identity.accessScope.replace(/_/g, ' ')}
                    </p>
                    <p className="mt-2 text-xs text-pf-deep/60">
                      {identity.accessCapabilities.length
                        ? identity.accessCapabilities.join(' · ')
                        : 'No capabilities recorded'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-pf-light bg-pf-surface/50 p-3">
                    <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/55">
                      Autonomy
                    </p>
                    <p className="mt-1 font-semibold text-pf-deep">
                      {identity.autonomyLevel.replace(/_/g, ' ')}
                    </p>
                    <p className="mt-2 text-xs text-pf-deep/60">
                      {identity.autonomousActions.length
                        ? identity.autonomousActions.join(' · ')
                        : 'No autonomous actions recorded'}
                    </p>
                  </div>
                </div>
                <p className="mt-4 text-xs text-pf-deep/55">
                  {identity.agentType.replace(/_/g, ' ')} · {identity._count.runs} runs ·{' '}
                  {identity._count.approvalRequests} approvals ·{' '}
                  {[identity.defaultProvider, identity.defaultModel].filter(Boolean).join(' / ') ||
                    'No default model'}
                </p>
                <IdentityConfigurationEditor
                  tenantId={tenantId}
                  venueId={venueId}
                  identity={identity}
                />
              </article>
            ))}
          </div>
        )}
        {identities.nextCursor ? (
          <Older
            href={cursorHref(base, 'identityCursor', identities.nextCursor)}
            label="Older identities"
          />
        ) : null}
      </section>

      <section className="space-y-4" aria-labelledby="agent-runs-heading">
        <div>
          <h3 id="agent-runs-heading" className="text-xl font-semibold text-pf-deep">
            Recent runs
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Lifecycle and bounded operational summaries.
          </p>
        </div>
        {runs.items.length === 0 ? (
          <Empty text="No agent runs are recorded for this venue." />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-pf-light bg-white">
            <table className="min-w-[52rem] w-full text-left text-sm">
              <thead className="border-b border-pf-light bg-pf-surface/50 text-xs uppercase tracking-wider text-pf-deep/55">
                <tr>
                  <th className="px-4 py-3">Run</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Evidence</th>
                  <th className="px-4 py-3">Cost</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {runs.items.map((run) => (
                  <tr key={run.id} className="border-b border-pf-light last:border-0">
                    <td className="px-4 py-4">
                      <Link
                        href={`${base}/runs/${run.id}`}
                        className="font-semibold text-pf-primary hover:text-pf-accent"
                      >
                        {run.agentIdentity.name}
                      </Link>
                      <p className="mt-1 text-xs text-pf-deep/55">
                        {run.requestedOperation} · {run.runType}
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      <Badge
                        tone={
                          run.status === 'COMPLETED'
                            ? 'green'
                            : run.status === 'FAILED'
                              ? 'rose'
                              : 'amber'
                        }
                      >
                        {run.status.replace(/_/g, ' ')}
                      </Badge>
                      {run.errorCode ? (
                        <p className="mt-2 text-xs text-rose-700">{run.errorCode}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-4 text-xs text-pf-deep/65">
                      {run._count.actions} actions · {run._count.timelineEvents} events ·{' '}
                      {run._count.approvalRequests} approvals
                    </td>
                    <td className="px-4 py-4 font-mono text-xs text-pf-deep">
                      {formatE8Usd(run.costE8Usd)}
                    </td>
                    <td className="px-4 py-4 text-xs text-pf-deep/55">
                      {run.createdAt.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {runs.nextCursor ? (
          <Older href={cursorHref(base, 'runCursor', runs.nextCursor)} label="Older runs" />
        ) : null}
      </section>

      <section className="space-y-4" aria-labelledby="approval-state-heading">
        <div>
          <h3 id="approval-state-heading" className="text-xl font-semibold text-pf-deep">
            Approval state
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Pending, resolved, and expired requests. This surface is observational only.
          </p>
        </div>
        {approvals.items.length === 0 ? (
          <Empty text="No approval requests are recorded for this venue." />
        ) : (
          <ul className="divide-y divide-pf-light rounded-2xl border border-pf-light bg-white px-5">
            {approvals.items.map((approval) => (
              <li key={approval.id} className="py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      approval.state === 'PENDING'
                        ? 'amber'
                        : approval.state === 'APPROVED'
                          ? 'green'
                          : 'slate'
                    }
                  >
                    {approval.state.replace(/_/g, ' ')}
                  </Badge>
                  <Badge
                    tone={
                      approval.riskCategory === 'CRITICAL' || approval.riskCategory === 'HIGH'
                        ? 'rose'
                        : 'slate'
                    }
                  >
                    {approval.riskCategory} risk
                  </Badge>
                  <span className="text-xs text-pf-deep/55">{approval.agentIdentity.name}</span>
                </div>
                <p className="mt-2 text-sm font-semibold text-pf-deep">{approval.proposedAction}</p>
                <p className="mt-1 text-sm text-pf-deep/65">{approval.reason}</p>
                {approval.state === 'PENDING' ? (
                  <ApprovalDecisionForm
                    tenantId={tenantId}
                    venueId={venueId}
                    approvalRequestId={approval.id}
                    proposedAction={approval.proposedAction}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {approvals.nextCursor ? (
          <Older
            href={cursorHref(base, 'approvalCursor', approvals.nextCursor)}
            label="Older approvals"
          />
        ) : null}
      </section>
    </div>
  )
}

function IdentityConfigurationEditor({
  tenantId,
  venueId,
  identity,
}: {
  tenantId: string
  venueId: string
  identity: Identity
}) {
  const fields = AgentIdentityConfigurationFields.safeParse(identity)
  if (!fields.success) {
    return (
      <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
        This legacy identity uses authority values outside the staged allowlist. It can be reviewed
        here but requires a separate migration before it can use this editor.
      </p>
    )
  }
  return (
    <AgentIdentityEditEditor
      tenantId={tenantId}
      venueId={venueId}
      identity={{
        id: identity.id,
        enabled: identity.enabled,
        updatedAt: identity.updatedAt,
        ...fields.data,
      }}
    />
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-pf-light bg-white p-8 text-center text-sm text-pf-deep/65">
      {text}
    </div>
  )
}
function Older({ href, label }: { href: string; label: string }) {
  return (
    <div className="flex justify-end">
      <Link
        href={href}
        className="inline-flex min-h-11 items-center rounded-2xl border border-pf-light bg-white px-5 text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
      >
        {label}
      </Link>
    </div>
  )
}
