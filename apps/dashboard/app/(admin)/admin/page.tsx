export const dynamic = 'force-dynamic'

import Link from 'next/link'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Building2,
  CheckCircle2,
  Clock3,
  ServerCog,
} from 'lucide-react'

import { GlobalAiIncidentControl } from '../../../components/admin/GlobalAiIncidentControl'
import { createAdminCaller } from '../../../lib/admin-caller'
import { getJobStatusClasses, getStatusClasses } from '../../../lib/admin-status'

type AttentionItem = {
  id: string
  label: string
  detail: string
  href: string
  tone: 'critical' | 'warning' | 'info'
}

const attentionTone = {
  critical: 'border-rose-200 bg-rose-50 text-rose-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  info: 'border-sky-200 bg-sky-50 text-sky-900',
} as const

export default async function AdminOverviewPage() {
  const caller = await createAdminCaller()
  const [overview, globalAiControl, operations] = await Promise.all([
    caller.admin.overview(),
    caller.admin.getGlobalAiControl(),
    caller.admin.attentionConsole({ limit: 6 }),
  ])

  const attention: AttentionItem[] = []
  if (globalAiControl.paused || globalAiControl.malformed) {
    attention.push({
      id: 'ai-incident',
      label: globalAiControl.malformed
        ? 'AI incident control needs review'
        : 'AI operations paused',
      detail: globalAiControl.reason || 'Review the global incident state before resuming AI work.',
      href: '#incident-control',
      tone: 'critical',
    })
  }
  if (overview.jobs.failed7d > 0) {
    attention.push({
      id: 'failed-jobs',
      label: `${overview.jobs.failed7d} failed ${overview.jobs.failed7d === 1 ? 'job' : 'jobs'} in 7 days`,
      detail: 'Review recent failures, their tenant scope, and safe retry options.',
      href: '/admin/operations',
      tone: 'critical',
    })
  }
  if (operations.evaluations.items.length > 0) {
    attention.push({
      id: 'evaluation-attention',
      label: `${operations.evaluations.items.length}${operations.evaluations.nextCursor ? '+' : ''} evaluation runs need review`,
      detail: 'Includes failed, staged, retry-scheduled, and expired-lease runs.',
      href: '/admin/operations#evaluation-attention-heading',
      tone: 'critical',
    })
  }
  if (operations.approvals.items.length > 0) {
    attention.push({
      id: 'approval-attention',
      label: `${operations.approvals.items.length}${operations.approvals.nextCursor ? '+' : ''} approval requests are undecided`,
      detail: 'Review pending and expired approval windows in exact client scope.',
      href: '/admin/operations#approval-attention-heading',
      tone: 'warning',
    })
  }
  if (operations.support.items.length > 0) {
    attention.push({
      id: 'support-attention',
      label: `${operations.support.items.length}${operations.support.nextCursor ? '+' : ''} support requests need workflow attention`,
      detail: 'Waiting-for-client, validation, and approval states are represented.',
      href: '/admin/operations#support-attention-heading',
      tone: 'warning',
    })
  }
  if (overview.tenants.byStatus.SUSPENDED > 0) {
    attention.push({
      id: 'suspended-clients',
      label: `${overview.tenants.byStatus.SUSPENDED} suspended ${overview.tenants.byStatus.SUSPENDED === 1 ? 'client' : 'clients'}`,
      detail: 'Confirm access, offboarding, and operational state are intentional.',
      href: '/admin/directory?status=SUSPENDED',
      tone: 'warning',
    })
  }
  if (overview.tenants.byStatus.TRIAL > 0) {
    attention.push({
      id: 'trial-clients',
      label: `${overview.tenants.byStatus.TRIAL} ${overview.tenants.byStatus.TRIAL === 1 ? 'client is' : 'clients are'} in setup`,
      detail: 'Open the client workspace to check onboarding readiness and next actions.',
      href: '/admin/directory?status=TRIAL',
      tone: 'info',
    })
  }

  const recentClients = overview.tenants.recent
  const recentAgentRuns = operations.agents.items

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-5 border-b border-slate-200 pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
            PathFinder OS
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
            What needs attention?
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Triage platform work, enter a client workspace, and understand operating health without
            scanning the entire customer directory.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-600">
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5">
            <Building2 className="h-4 w-4 text-sky-700" aria-hidden="true" />
            {overview.tenants.total} clients
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5">
            {overview.content.venueCount} venues
          </span>
        </div>
      </header>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <div>
              <h2 className="font-semibold text-slate-950">Needs attention</h2>
              <p className="mt-0.5 text-xs text-slate-500">Prioritized operational exceptions</p>
            </div>
            <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden="true" />
          </div>
          {attention.length === 0 ? (
            <div className="flex min-h-52 flex-col items-center justify-center px-6 py-10 text-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-600" aria-hidden="true" />
              <h3 className="mt-3 font-semibold text-slate-950">No current exceptions</h3>
              <p className="mt-1 max-w-sm text-sm text-slate-500">
                Current job, client, and incident signals do not require immediate action.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {attention.map((item) => (
                <li key={item.id} className="p-3 sm:p-4">
                  <Link
                    href={item.href}
                    className={`group flex items-start gap-4 rounded-xl border p-4 transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${attentionTone[item.tone]}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{item.label}</span>
                      <span className="mt-1 block text-sm opacity-75">{item.detail}</span>
                    </span>
                    <ArrowRight
                      className="mt-0.5 h-4 w-4 shrink-0 transition group-hover:translate-x-0.5 motion-reduce:transform-none"
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-950 text-white shadow-sm">
          <div className="border-b border-slate-800 px-5 py-4">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-sky-300" aria-hidden="true" />
              <h2 className="font-semibold">Agent activity</h2>
            </div>
            <p className="mt-1 text-xs text-slate-400">Live work and approval state</p>
          </div>
          <div className="p-5">
            {recentAgentRuns.length === 0 ? (
              <div className="min-h-40 rounded-xl border border-dashed border-slate-700 p-5">
                <p className="font-medium text-slate-100">No recent runs</p>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  No agent lifecycle records are available in the current bounded snapshot.
                </p>
                <Link
                  href="/admin/operations"
                  className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-sky-300 hover:text-sky-200"
                >
                  Open operations <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
            ) : (
              <ul className="space-y-3">
                {recentAgentRuns.slice(0, 4).map((run) => (
                  <li key={run.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                    <p className="truncate text-sm font-semibold text-slate-100">
                      {run.requestedOperation}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      {run.agentIdentity.name} · {run.status.replaceAll('_', ' ')}
                    </p>
                    {run.venueId ? (
                      <Link
                        href={`/admin/clients/${run.tenantId}/venues/${run.venueId}/agents/runs/${run.id}`}
                        className="mt-2 inline-block text-xs font-semibold text-sky-300"
                      >
                        Open run evidence
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold text-slate-950">Recent work</h2>
              <p className="mt-1 text-xs text-slate-500">Recently created client accounts</p>
            </div>
            <Link
              href="/admin/directory"
              className="text-sm font-semibold text-sky-700 hover:text-sky-900"
            >
              Full directory
            </Link>
          </div>
          {recentClients.length === 0 ? (
            <p className="mt-6 rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">
              No client accounts yet.
            </p>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {recentClients.map((client) => (
                <Link
                  key={client.id}
                  href={`/admin/clients/${client.id}`}
                  className="group flex items-center justify-between gap-4 rounded-xl border border-slate-200 p-4 transition hover:border-sky-300 hover:bg-sky-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-slate-950">
                      {client.name}
                    </span>
                    <span className="mt-1 block truncate text-xs text-slate-500">
                      {client.slug}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${getStatusClasses(client.status)}`}
                  >
                    {client.status}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <ServerCog className="h-5 w-5 text-sky-700" aria-hidden="true" />
            <h2 className="font-semibold text-slate-950">Operational status</h2>
          </div>
          <dl className="mt-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-sm text-slate-600">AI control</dt>
              <dd
                className={`text-sm font-semibold ${globalAiControl.paused ? 'text-rose-700' : 'text-emerald-700'}`}
              >
                {globalAiControl.paused ? 'Paused' : 'Available'}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-sm text-slate-600">Failed jobs, 7d</dt>
              <dd
                className={`text-sm font-semibold ${overview.jobs.failed7d ? 'text-rose-700' : 'text-slate-900'}`}
              >
                {overview.jobs.failed7d}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-sm text-slate-600">Active venues</dt>
              <dd className="text-sm font-semibold text-slate-900">
                {overview.content.venueCount}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section id="incident-control" className="scroll-mt-24">
        <GlobalAiIncidentControl
          initialState={{
            paused: globalAiControl.paused,
            reason: globalAiControl.reason,
            configured: globalAiControl.configured,
            malformed: globalAiControl.malformed,
            updatedAt: globalAiControl.updatedAt?.toISOString() ?? null,
            updatedBy: globalAiControl.updatedBy,
          }}
        />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-sky-700" aria-hidden="true" />
            <h2 className="font-semibold text-slate-950">Recent operations</h2>
          </div>
          <Link
            href="/admin/operations"
            className="text-sm font-semibold text-sky-700 hover:text-sky-900"
          >
            View all
          </Link>
        </div>
        {overview.jobs.recent.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">No job runs recorded yet.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {overview.jobs.recent.slice(0, 5).map((job) => (
              <li
                key={job.id}
                className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">{job.jobName}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{job.queue}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span
                    className={`inline-flex rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${getJobStatusClasses(job.status)}`}
                  >
                    {job.status}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                    <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                    {job.createdAt.toLocaleString()}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
