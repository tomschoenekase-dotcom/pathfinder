'use client'

import Link from 'next/link'
import { useOrganization } from '@clerk/nextjs'
import {
  ArrowUpRight,
  Check,
  CircleHelp,
  Clock3,
  Megaphone,
  MessageCircle,
  Sparkles,
} from 'lucide-react'

type DashboardOverviewProps = {
  venue: {
    id: string
    name: string
    isActive: boolean
    placeCount: number
  }
  venues: Array<{ id: string; name: string }>
  activeUpdates: number
  chatUrl?: string | null
  impersonatedTenantName?: string
}

export function DashboardOverview({
  venue,
  venues,
  activeUpdates,
  chatUrl,
  impersonatedTenantName,
}: DashboardOverviewProps) {
  const { organization } = useOrganization()
  const orgName = impersonatedTenantName ?? organization?.name ?? venue.name
  const isReady = venue.isActive && venue.placeCount > 0

  return (
    <div className="min-h-screen px-4 py-6 sm:px-6 sm:py-10 lg:px-10">
      <div className="mx-auto max-w-6xl space-y-6 sm:space-y-8">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-pf-primary">Welcome back</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-pf-deep sm:text-4xl">
              {orgName}
            </h1>
            {venues.length > 1 ? (
              <nav className="mt-3 flex flex-wrap gap-2" aria-label="Choose venue">
                {venues.map((option) => {
                  const selected = option.id === venue.id
                  return (
                    <Link
                      key={option.id}
                      href={`/?venue=${encodeURIComponent(option.id)}`}
                      aria-current={selected ? 'page' : undefined}
                      className={[
                        'rounded-full border px-3 py-1 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent',
                        selected
                          ? 'border-pf-primary bg-pf-primary text-white'
                          : 'border-pf-light bg-white text-pf-deep hover:border-pf-accent',
                      ].join(' ')}
                    >
                      {option.name}
                    </Link>
                  )
                })}
              </nav>
            ) : null}
          </div>
          {chatUrl ? (
            <a
              href={chatUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-pf-deep px-6 text-sm font-semibold text-white shadow-sm transition hover:bg-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
            >
              Open PathFinder <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
          ) : null}
        </header>

        <section className="overflow-hidden rounded-[2rem] bg-pf-deep text-white shadow-sm">
          <div className="grid gap-8 px-6 py-8 sm:px-9 sm:py-10 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-sm font-medium">
                {isReady ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-emerald-300" /> PathFinder is live
                  </>
                ) : (
                  <>
                    <Clock3 className="h-4 w-4" aria-hidden="true" /> Your PathFinder is being
                    prepared
                  </>
                )}
              </div>
              <h2 className="mt-6 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">
                {isReady
                  ? 'Your visitors can explore with PathFinder now.'
                  : 'We’re building the experience for your visitors.'}
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-pf-light/80">
                {isReady
                  ? 'Use this portal for timely visitor updates, voice preferences, and help from the PathFinder team.'
                  : 'We’ll keep this page current as your content is reviewed and your first preview becomes ready.'}
              </p>
            </div>
            <div className="rounded-3xl bg-white/10 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-light/90">
                Right now
              </p>
              <p className="mt-3 text-lg font-semibold">
                {activeUpdates === 0
                  ? 'No temporary visitor updates'
                  : `${activeUpdates} visitor update${activeUpdates === 1 ? '' : 's'} live`}
              </p>
              <Link
                href="/operational-updates/new"
                className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-white underline decoration-white/30 underline-offset-4 hover:decoration-white"
              >
                Add an update <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>

        {!isReady ? (
          <section
            aria-labelledby="next-step-heading"
            className="rounded-[2rem] border border-pf-light bg-white p-6 shadow-sm sm:p-8"
          >
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                <Check className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <p className="text-sm font-medium text-pf-primary">Your next step</p>
                <h2 id="next-step-heading" className="mt-1 text-xl font-semibold text-pf-deep">
                  {venue.placeCount === 0
                    ? 'Your information is with the PathFinder team'
                    : 'Preview preparation is underway'}
                </h2>
                <p className="mt-2 text-sm leading-6 text-pf-deep/75">
                  {venue.placeCount === 0
                    ? 'There is nothing technical for you to configure here. We’ll ask for any missing information as we assemble your PathFinder.'
                    : 'Your venue information has been added. We’ll let you know here when the visitor preview is ready.'}
                </p>
              </div>
            </div>
          </section>
        ) : null}

        <section aria-labelledby="manage-heading">
          <div>
            <p className="text-sm font-medium text-pf-primary">Keep it current</p>
            <h2
              id="manage-heading"
              className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep"
            >
              The essentials
            </h2>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <Link
              href="/operational-updates"
              className="group rounded-[1.75rem] border border-pf-light bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-pf-accent/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent motion-reduce:transform-none motion-reduce:transition-none"
            >
              <Megaphone className="h-5 w-5 text-pf-primary" aria-hidden="true" />
              <h3 className="mt-5 text-lg font-semibold text-pf-deep">Visitor updates</h3>
              <p className="mt-2 text-sm leading-6 text-pf-deep/75">
                Share a closure, event, parking change, or other temporary notice.
              </p>
              <span className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-pf-primary">
                Manage updates{' '}
                <ArrowUpRight
                  className="h-4 w-4 transition group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </span>
            </Link>
            <Link
              href="/ai-controls"
              className="group rounded-[1.75rem] border border-pf-light bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-pf-accent/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent motion-reduce:transform-none motion-reduce:transition-none"
            >
              <Sparkles className="h-5 w-5 text-pf-primary" aria-hidden="true" />
              <h3 className="mt-5 text-lg font-semibold text-pf-deep">PathFinder tone</h3>
              <p className="mt-2 text-sm leading-6 text-pf-deep/75">
                Choose a simple voice that feels right for your visitors.
              </p>
              <span className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-pf-primary">
                Choose a tone{' '}
                <ArrowUpRight
                  className="h-4 w-4 transition group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </span>
            </Link>
            <Link
              href="/support"
              className="group rounded-[1.75rem] border border-pf-light bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-pf-accent/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent motion-reduce:transform-none motion-reduce:transition-none"
            >
              <MessageCircle className="h-5 w-5 text-pf-primary" aria-hidden="true" />
              <h3 className="mt-5 text-lg font-semibold text-pf-deep">PathFinder Support</h3>
              <p className="mt-2 text-sm leading-6 text-pf-deep/75">
                See the current support option for questions and change requests.
              </p>
              <span className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-pf-primary">
                Get support <CircleHelp className="h-4 w-4" aria-hidden="true" />
              </span>
            </Link>
          </div>
        </section>
      </div>
    </div>
  )
}
