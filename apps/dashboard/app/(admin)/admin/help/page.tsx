import Link from 'next/link'
import {
  AlertTriangle,
  BookOpen,
  LifeBuoy,
  RotateCcw,
  ShieldCheck,
  WandSparkles,
} from 'lucide-react'

const workflows = [
  {
    title: 'Create and onboard',
    detail: 'Create the client, collect raw inputs, review intake evidence, and prepare a preview.',
    href: '/admin/new',
    icon: WandSparkles,
  },
  {
    title: 'Review and publish',
    detail:
      'Work from a client and venue scope. Validate package evidence before approval or apply.',
    href: '/admin/directory',
    icon: ShieldCheck,
  },
  {
    title: 'Support and revisions',
    detail:
      'Keep client-visible replies separate from internal notes and convert requests into reviewable changes.',
    href: '/admin/directory',
    icon: LifeBuoy,
  },
  {
    title: 'Rollback and recovery',
    detail:
      'Use versioned package/history controls. Never improvise a database rollback during the incident stop.',
    href: '/admin/operations',
    icon: RotateCcw,
  },
] as const

export default function AdminHelpPage() {
  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
          Operator guide
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          Run Torchiko safely
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
          Start with scope, preserve evidence, preview client-visible changes, and use the approval
          boundary before production effects.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-2" aria-label="Core operator workflows">
        {workflows.map((workflow) => {
          const Icon = workflow.icon
          return (
            <Link
              key={workflow.title}
              href={workflow.href}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-sky-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 motion-reduce:transition-none"
            >
              <Icon className="h-5 w-5 text-sky-700" aria-hidden="true" />
              <h2 className="mt-4 text-lg font-semibold text-slate-950">{workflow.title}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">{workflow.detail}</p>
            </Link>
          )
        })}
      </section>

      <section
        className="rounded-2xl border border-amber-300 bg-amber-50 p-6"
        aria-labelledby="incident-help"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-800" aria-hidden="true" />
          <div>
            <h2 id="incident-help" className="font-semibold text-amber-950">
              Database incident boundary is active
            </h2>
            <p className="mt-2 text-sm leading-6 text-amber-900">
              Code, contracts, local tests, and unapplied migrations may continue. External database
              inspection, migration, remediation, restore, or stop-lift work requires separate owner
              authorization.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-slate-950 p-6 text-slate-100">
        <BookOpen className="h-5 w-5 text-sky-300" aria-hidden="true" />
        <h2 className="mt-4 text-lg font-semibold">Detailed runbooks</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
          The repository operator handbook covers creation, onboarding, intake review, preview,
          publication, rollback, support, AI controls, agents, evaluations, failures, offboarding,
          and incidents. Architecture and developer guides document the shared service boundaries.
        </p>
      </section>
    </div>
  )
}
