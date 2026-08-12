'use client'

import Link from 'next/link'
import { useOrganization } from '@clerk/nextjs'
import { ArrowUpRight, CircleHelp, Megaphone, MessageCircle, Sparkles } from 'lucide-react'

import type { ClientPortalLifecycleView } from '@pathfinder/contracts/client-portal-lifecycle'

type DashboardOverviewProps = {
  venue: {
    id: string
    name: string
    lifecycle: ClientPortalLifecycleView
    clientPreview?: { state: 'AVAILABLE' | 'SUPERSEDED' | 'UNAVAILABLE'; id: string | null }
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
  const lifecycle = venue.lifecycle
  const clientPreview = venue.clientPreview ?? { state: 'UNAVAILABLE' as const, id: null }
  const showLiveTools = lifecycle.state === 'LIVE' || lifecycle.state === 'PAUSED'
  const publicGuestLinkAvailable = lifecycle.state === 'READY' || lifecycle.state === 'LIVE'
  const previewHref =
    lifecycle.state === 'CLIENT_PREVIEW' && clientPreview.state === 'AVAILABLE' && clientPreview.id
      ? `/venues/${encodeURIComponent(venue.id)}/preview/${encodeURIComponent(clientPreview.id)}`
      : null
  const action =
    lifecycle.clientAction === 'CONTINUE_INTAKE'
      ? { href: `/venues/${encodeURIComponent(venue.id)}/intake`, label: 'Continue setup' }
      : lifecycle.clientAction === 'CONTACT_SUPPORT'
        ? { href: '/support', label: 'Contact Support' }
        : null

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
                      className={
                        selected
                          ? 'rounded-full border border-pf-primary bg-pf-primary px-3 py-1 text-xs font-semibold text-white'
                          : 'rounded-full border border-pf-light bg-white px-3 py-1 text-xs font-semibold text-pf-deep'
                      }
                    >
                      {option.name}
                    </Link>
                  )
                })}
              </nav>
            ) : null}
          </div>
          {chatUrl && publicGuestLinkAvailable ? (
            <a
              href={chatUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-pf-deep px-6 text-sm font-semibold text-white"
            >
              Open visitor experience <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
          ) : null}
        </header>

        <section className="overflow-hidden rounded-[2rem] bg-pf-deep text-white shadow-sm">
          <div className="grid gap-8 px-6 py-8 sm:px-9 sm:py-10 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-sm font-medium">
                <span className="h-2 w-2 rounded-full bg-emerald-300" aria-hidden="true" />
                {lifecycle.label}
              </div>
              <h2 className="mt-6 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">
                {lifecycle.headline}
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-pf-light/80">
                {lifecycle.summary}
              </p>
            </div>
            {showLiveTools ? (
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
                  className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-white underline underline-offset-4"
                >
                  Add an update <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
            ) : null}
          </div>
        </section>

        {lifecycle.clientActionRequired ||
        (lifecycle.state === 'CLIENT_PREVIEW' && clientPreview.state !== 'AVAILABLE') ? (
          <section
            aria-labelledby="next-step-heading"
            className="rounded-[2rem] border border-pf-light bg-white p-6 shadow-sm sm:p-8"
          >
            <p className="text-sm font-medium text-pf-primary">Your next step</p>
            <h2 id="next-step-heading" className="mt-1 text-xl font-semibold text-pf-deep">
              {lifecycle.clientAction === 'OPEN_PREVIEW'
                ? 'Review the visitor experience'
                : lifecycle.headline}
            </h2>
            <p className="mt-2 text-sm leading-6 text-pf-deep/75">{lifecycle.summary}</p>
            {lifecycle.state === 'CLIENT_PREVIEW' && clientPreview.state === 'SUPERSEDED' ? (
              <p
                className="mt-4 rounded-2xl bg-pf-surface p-4 text-sm text-pf-deep/75"
                role="status"
              >
                An updated exact preview is being prepared. We will make it available here when it
                is ready.
              </p>
            ) : lifecycle.state === 'CLIENT_PREVIEW' && clientPreview.state === 'UNAVAILABLE' ? (
              <p
                className="mt-4 rounded-2xl bg-pf-surface p-4 text-sm text-pf-deep/75"
                role="status"
              >
                This preview is temporarily unavailable. PathFinder will make a reviewed preview
                available here when it is ready.
              </p>
            ) : lifecycle.state === 'CLIENT_PREVIEW' && previewHref ? (
              <Link
                href={previewHref}
                className="mt-4 inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white"
              >
                Open preview
              </Link>
            ) : lifecycle.state !== 'CLIENT_PREVIEW' &&
              lifecycle.clientAction === 'OPEN_PREVIEW' &&
              chatUrl ? (
              <a
                href={chatUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white"
              >
                Open visitor experience
              </a>
            ) : action ? (
              <Link
                href={action.href}
                className="mt-4 inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white"
              >
                {action.label}
              </Link>
            ) : null}
          </section>
        ) : null}

        {showLiveTools ? (
          <section aria-labelledby="manage-heading">
            <p className="text-sm font-medium text-pf-primary">Keep it current</p>
            <h2 id="manage-heading" className="mt-1 text-2xl font-semibold text-pf-deep">
              The essentials
            </h2>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              {[
                {
                  href: '/operational-updates',
                  title: 'Visitor updates',
                  body: 'Share a closure, event, parking change, or temporary notice.',
                  Icon: Megaphone,
                },
                {
                  href: '/ai-controls',
                  title: 'PathFinder tone',
                  body: 'Choose a simple voice that feels right for your visitors.',
                  Icon: Sparkles,
                },
                {
                  href: '/support',
                  title: 'PathFinder Support',
                  body: 'Ask a question or request a change from the PathFinder team.',
                  Icon: MessageCircle,
                },
              ].map(({ href, title, body, Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className="rounded-[1.75rem] border border-pf-light bg-white p-6 shadow-sm"
                >
                  <Icon className="h-5 w-5 text-pf-primary" aria-hidden="true" />
                  <h3 className="mt-5 text-lg font-semibold text-pf-deep">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-pf-deep/75">{body}</p>
                  <span className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-pf-primary">
                    Open <CircleHelp className="h-4 w-4" aria-hidden="true" />
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
