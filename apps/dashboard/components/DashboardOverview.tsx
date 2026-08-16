'use client'

import Link from 'next/link'
import { useOrganization } from '@clerk/nextjs'
import { ArrowUpRight, CircleHelp, Megaphone, MessageCircle, Sparkles } from 'lucide-react'

import type { ClientPortalLifecycleView } from '@pathfinder/contracts/client-portal-lifecycle'
import { SecondLayerSettings } from './SecondLayerSettings'

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
  tasks?: ClientPortalTask[]
  secondLayer?: {
    enabled: boolean
    label: string
    url: string | null
    updatedAt: string
  }
}

export type ClientPortalTask = {
  id: string
  title: string
  description: string
  href: string
  required: boolean
  items?: string[]
  additionalItemCount?: number
}

export function DashboardOverview({
  venue,
  venues,
  activeUpdates,
  chatUrl,
  impersonatedTenantName,
  tasks,
  secondLayer,
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
  const fallbackTasks: ClientPortalTask[] = previewHref
    ? [
        {
          id: 'preview',
          title: 'Review the visitor experience',
          description: lifecycle.summary,
          href: previewHref,
          required: true,
        },
      ]
    : action
      ? [
          {
            id: lifecycle.clientAction.toLowerCase(),
            title: action.label,
            description: lifecycle.summary,
            href: action.href,
            required: true,
          },
        ]
      : lifecycle.state !== 'CLIENT_PREVIEW' && lifecycle.clientAction === 'OPEN_PREVIEW' && chatUrl
        ? [
            {
              id: 'open-visitor-experience',
              title: 'Open visitor experience',
              description: lifecycle.summary,
              href: chatUrl,
              required: true,
            },
          ]
        : []
  const visibleTasks = tasks ?? fallbackTasks
  const requiredTaskCount = visibleTasks.filter((task) => task.required).length

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

        {secondLayer?.enabled ? (
          <SecondLayerSettings
            venueId={venue.id}
            enabled={secondLayer.enabled}
            initialLabel={secondLayer.label}
            initialUrl={secondLayer.url}
            initialUpdatedAt={secondLayer.updatedAt}
          />
        ) : null}

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

        {visibleTasks.length > 0 ||
        (lifecycle.state === 'CLIENT_PREVIEW' && clientPreview.state !== 'AVAILABLE') ? (
          <section
            aria-labelledby="next-step-heading"
            className="rounded-[2rem] border border-pf-light bg-white p-6 shadow-sm sm:p-8"
          >
            <p className="text-sm font-medium text-pf-primary">
              {requiredTaskCount === 0
                ? 'Available now'
                : requiredTaskCount > 1
                  ? 'Your next steps'
                  : 'Your next step'}
            </p>
            <h2 id="next-step-heading" className="mt-1 text-xl font-semibold text-pf-deep">
              {requiredTaskCount === 0
                ? 'More from Torchico'
                : visibleTasks.length > 1
                  ? 'What we need from you'
                  : (visibleTasks[0]?.title ?? lifecycle.headline)}
            </h2>
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
                This preview is temporarily unavailable. Torchico will make a reviewed preview
                available here when it is ready.
              </p>
            ) : visibleTasks.length > 0 ? (
              <ol className="mt-5 space-y-3" aria-label="Torchico tasks">
                {visibleTasks.map((task, index) => {
                  const external = /^https?:\/\//u.test(task.href)
                  const content = (
                    <>
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pf-primary/10 text-sm font-semibold text-pf-primary">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <strong className="text-pf-deep">{task.title}</strong>
                          {task.required ? (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide text-amber-800">
                              Action needed
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-1 block text-sm leading-6 text-pf-deep/70">
                          {task.description}
                        </span>
                        {task.items?.length ? (
                          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-pf-deep/75">
                            {task.items.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                            {task.additionalItemCount ? (
                              <li>
                                {task.additionalItemCount} more detail
                                {task.additionalItemCount === 1 ? '' : 's'} in Support
                              </li>
                            ) : null}
                          </ul>
                        ) : null}
                        <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-pf-primary">
                          Open <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                        </span>
                      </span>
                    </>
                  )
                  return (
                    <li key={task.id}>
                      {external ? (
                        <a
                          href={task.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex gap-3 rounded-2xl border border-pf-light bg-pf-surface/40 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                        >
                          {content}
                        </a>
                      ) : (
                        <Link
                          href={task.href}
                          className="flex gap-3 rounded-2xl border border-pf-light bg-pf-surface/40 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                        >
                          {content}
                        </Link>
                      )}
                    </li>
                  )
                })}
              </ol>
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
                  title: 'Torchico tone',
                  body: 'Choose a simple voice that feels right for your visitors.',
                  Icon: Sparkles,
                },
                {
                  href: '/support',
                  title: 'Torchico Support',
                  body: 'Ask a question or request a change from the Torchico team.',
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
