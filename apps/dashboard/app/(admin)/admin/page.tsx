export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { ArrowRight, CheckCircle2, CircleAlert, HeartPulse } from 'lucide-react'
import { createAdminCaller } from '../../../lib/admin-caller'

type AttentionItem = {
  label: string
  detail: string
  href: string
  count: number
  more?: boolean
  urgent?: boolean
}

export default async function AdminOverviewPage() {
  const caller = await createAdminCaller()
  const [overview, incident, providers, operations] = await Promise.all([
    caller.admin.overview(),
    caller.admin.getGlobalAiControl(),
    caller.admin.getAiProviderHealthControl(),
    caller.admin.attentionConsole({ limit: 10 }),
  ])
  const attention: AttentionItem[] = [
    {
      label: 'AI incident needs review',
      detail: 'Inspect the paused or malformed global AI control.',
      href: '/admin/operations?view=system#incident-control',
      count: incident.paused || incident.malformed ? 1 : 0,
      urgent: true,
    },
    {
      label: 'AI provider routing needs review',
      detail: 'Inspect unhealthy providers or a malformed health control.',
      href: '/admin/operations?view=system#provider-health-control',
      count: providers.malformed || providers.activeUnhealthyProviders.length > 0 ? 1 : 0,
      urgent: true,
    },
    {
      label: 'Questions for you',
      detail: 'Agents are waiting for a human answer.',
      href: '/admin/operations?view=work#needs-you-heading',
      count: operations.questions.items.length,
      more: !!operations.questions.nextCursor,
    },
    {
      label: 'Approvals to decide',
      detail: 'Review the exact client scope before deciding.',
      href: '/admin/operations?view=work#approval-attention-heading',
      count: operations.approvals.items.length,
      more: !!operations.approvals.nextCursor,
    },
    {
      label: 'Blocked agent work',
      detail: 'Open the run evidence and decide what can proceed.',
      href: '/admin/operations?view=work#ai-workforce',
      count: operations.blockedAgents.items.length,
      more: !!operations.blockedAgents.nextCursor,
      urgent: true,
    },
    {
      label: 'Failed jobs',
      detail: 'Inspect recent failures and safe retry options.',
      href: '/admin/operations?view=work#job-attention-heading',
      count: overview.jobs.failed7d,
      urgent: true,
    },
    {
      label: 'Evaluation runs to review',
      detail: 'Includes failed, staged, retry-scheduled and expired-lease runs.',
      href: '/admin/operations?view=work#evaluation-attention-heading',
      count: operations.evaluations.items.length,
      more: !!operations.evaluations.nextCursor,
    },
    {
      label: 'Support requests',
      detail: 'Requests waiting for validation, approval or a client reply.',
      href: '/admin/operations?view=work#support-attention-heading',
      count: operations.support.items.length,
      more: !!operations.support.nextCursor,
    },
    {
      label: 'Suspended clients',
      detail: 'Confirm access, offboarding and operating state are intentional.',
      href: '/admin/directory?status=SUSPENDED',
      count: overview.tenants.byStatus.SUSPENDED,
    },
    {
      label: 'Clients in setup',
      detail: 'Check onboarding readiness and next actions.',
      href: '/admin/directory?status=TRIAL',
      count: overview.tenants.byStatus.TRIAL,
    },
  ].filter((item) => item.count > 0)
  const agentRuns = operations.workingAgents.items.length
  const providerWarning = providers.malformed || providers.activeUnhealthyProviders.length > 0
  const incidentWarning = incident.paused || incident.malformed

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="border-b border-slate-200 pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
          Your workspace
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
          Needs you
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Decisions and exceptions that need your attention now.
        </p>
      </header>
      <section
        aria-labelledby="needs-you-list-heading"
        className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 id="needs-you-list-heading" className="font-semibold text-slate-950">
            Your attention list
          </h2>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
            {attention.reduce((sum, item) => sum + item.count, 0)}
            {attention.some((item) => item.more) ? '+' : ''} items
          </span>
        </div>
        {attention.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center">
            <CheckCircle2 className="h-9 w-9 text-emerald-600" aria-hidden="true" />
            <h3 className="mt-4 text-lg font-semibold text-slate-950">Nothing needs you.</h3>
            <p className="mt-1 text-sm text-slate-600">
              Agents are handling {agentRuns}
              {operations.workingAgents.nextCursor ? '+' : ''}{' '}
              {agentRuns === 1 && !operations.workingAgents.nextCursor ? 'run' : 'runs'}.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {attention.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="group flex min-h-20 items-center gap-4 px-5 py-4 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500"
                >
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${item.urgent ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-800'}`}
                  >
                    <CircleAlert className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-slate-950">{item.label}</span>
                    <span className="mt-0.5 block text-sm text-slate-600">{item.detail}</span>
                  </span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-bold text-slate-900">
                    {item.count}
                    {item.more ? '+' : ''}
                  </span>
                  <ArrowRight
                    className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 motion-reduce:transform-none"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section
        aria-label="System health"
        className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-200 pt-4 text-sm text-slate-600"
      >
        <span className="inline-flex items-center gap-2 font-medium text-slate-700">
          <HeartPulse className="h-4 w-4" aria-hidden="true" /> System health
        </span>
        <Link
          id="incident-control"
          href="/admin/operations?view=system#incident-control"
          className="scroll-mt-24 underline decoration-slate-300 underline-offset-4 hover:text-sky-800"
        >
          AI incident: {incidentWarning ? 'needs review' : 'clear'}
        </Link>
        <Link
          id="provider-health-control"
          href="/admin/operations?view=system#provider-health-control"
          className="scroll-mt-24 underline decoration-slate-300 underline-offset-4 hover:text-sky-800"
        >
          Providers: {providerWarning ? 'needs review' : 'available'}
        </Link>
        <Link
          href="/admin/operations?view=work#job-attention-heading"
          className="underline decoration-slate-300 underline-offset-4 hover:text-sky-800"
        >
          Queues: {overview.jobs.failed7d} failed in 7 days
        </Link>
      </section>
    </div>
  )
}
