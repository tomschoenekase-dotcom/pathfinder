'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { useOrganization } from '@clerk/nextjs'
import { ArrowRight, ArrowUpRight, Headphones, Megaphone, Sparkles } from 'lucide-react'

import type { ClientPortalLifecycleView } from '@pathfinder/contracts/client-portal-lifecycle'
import { SecondLayerSettings } from './SecondLayerSettings'
import { TorchikoCore, type TorchikoCoreState } from './TorchikoCore'

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
  secondLayer?: { enabled: boolean; label: string; url: string | null; updatedAt: string }
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

function PortalActionLink({
  href,
  className,
  children,
}: {
  href: string
  className: string
  children: ReactNode
}) {
  return /^https?:\/\//u.test(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  )
}

function coreStateFor(lifecycle: ClientPortalLifecycleView): TorchikoCoreState {
  if (lifecycle.state === 'LIVE') return 'live'
  if (lifecycle.state === 'CLIENT_PREVIEW' || lifecycle.state === 'READY') return 'ready'
  if (
    lifecycle.state === 'PROCESSING' ||
    lifecycle.state === 'INTERNAL_REVIEW' ||
    lifecycle.state === 'REVISIONS'
  )
    return 'processing'
  if (lifecycle.state === 'COLLECTING') return 'share'
  if (lifecycle.state === 'PAUSED' || lifecycle.state === 'OFFBOARDING') return 'questions'
  return 'welcome'
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
      ? { href: `/venues/${encodeURIComponent(venue.id)}/onboarding`, label: 'Continue setup' }
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
  const primaryTask = visibleTasks[0] ?? null
  const secondaryTasks = visibleTasks.slice(1)
  const previewUnavailable =
    lifecycle.state === 'CLIENT_PREVIEW' && clientPreview.state !== 'AVAILABLE'

  return (
    <div className="min-h-screen px-4 py-6 sm:px-7 sm:py-9 lg:px-12 lg:py-12">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-4 border-b border-pf-light/80 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
              Today
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-pf-deep sm:text-4xl">
              {orgName}
            </h1>
          </div>
          {venues.length > 1 ? (
            <div className="min-w-48">
              <label
                htmlFor="portal-venue"
                className="mb-1.5 block text-xs font-medium text-pf-deep/65"
              >
                Viewing venue
              </label>
              <select
                id="portal-venue"
                value={venue.id}
                onChange={(event) => {
                  window.location.href = `/?venue=${encodeURIComponent(event.currentTarget.value)}`
                }}
                className="min-h-11 w-full border-b-2 border-pf-light bg-transparent px-1 text-sm font-semibold text-pf-deep focus:border-pf-primary focus:outline-none"
              >
                {venues.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </header>

        <section className="relative mt-6 overflow-hidden bg-pf-deep text-white shadow-[0_24px_60px_-36px_rgba(15,42,74,0.8)]">
          <div
            className="absolute right-[-5rem] top-[-3rem] h-52 w-52 rounded-full bg-[#4dbdc2]/10 blur-3xl"
            aria-hidden="true"
          />
          <div className="grid min-h-[25rem] md:grid-cols-[minmax(0,1.15fr)_minmax(16rem,0.85fr)]">
            <div className="relative z-10 flex flex-col justify-between px-6 py-8 sm:px-10 sm:py-11">
              <div>
                <p className="flex items-center gap-3 text-sm font-semibold text-[#9ee0df]">
                  <span className="h-px w-7 bg-[#f2a65a]" aria-hidden="true" />
                  {lifecycle.label}
                </p>
                <h2 className="mt-6 max-w-2xl text-3xl font-semibold tracking-[-0.035em] sm:text-4xl lg:text-[2.75rem] lg:leading-[1.08]">
                  {lifecycle.headline}
                </h2>
                <p className="mt-4 max-w-xl text-base leading-7 text-pf-light/80">
                  {lifecycle.summary}
                </p>
              </div>

              {primaryTask ? (
                <div className="mt-9 border-l-2 border-[#f2a65a] pl-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#f5c078]">
                    {primaryTask.required ? 'Your next step' : 'Available now'}
                  </p>
                  <h3 className="mt-2 text-xl font-semibold">{primaryTask.title}</h3>
                  {primaryTask.items?.length ? (
                    <p className="mt-2 text-sm leading-6 text-pf-light/75">
                      {primaryTask.items.slice(0, 2).join(' · ')}
                      {primaryTask.additionalItemCount
                        ? ` · ${primaryTask.additionalItemCount} more in Help & changes`
                        : ''}
                    </p>
                  ) : null}
                  <PortalActionLink
                    href={primaryTask.href}
                    className="mt-5 inline-flex min-h-12 items-center justify-center gap-2 bg-white px-5 text-sm font-semibold text-pf-deep transition hover:bg-[#eaf7f6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f2a65a] focus-visible:ring-offset-2 focus-visible:ring-offset-pf-deep"
                  >
                    {primaryTask.title}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </PortalActionLink>
                </div>
              ) : chatUrl && publicGuestLinkAvailable ? (
                <a
                  href={chatUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-9 inline-flex min-h-12 w-fit items-center justify-center gap-2 bg-white px-5 text-sm font-semibold text-pf-deep transition hover:bg-[#eaf7f6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f2a65a] focus-visible:ring-offset-2 focus-visible:ring-offset-pf-deep"
                >
                  Open visitor experience <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </a>
              ) : previewUnavailable ? (
                <p
                  className="mt-9 max-w-xl border-l-2 border-[#f2a65a] pl-5 text-sm leading-6 text-pf-light/80"
                  role="status"
                >
                  {clientPreview.state === 'SUPERSEDED'
                    ? 'An updated exact preview is being prepared. We will make it available here when it is ready.'
                    : 'This preview is temporarily unavailable. Torchiko will make a reviewed preview available here when it is ready.'}
                </p>
              ) : (
                <p className="mt-9 text-sm font-medium text-[#9ee0df]">
                  Nothing you need to do right now.
                </p>
              )}
            </div>

            <div className="relative flex min-h-44 items-center justify-center border-t border-white/10 bg-white/[0.025] px-6 py-7 sm:min-h-52 md:border-l md:border-t-0">
              <TorchikoCore
                state={coreStateFor(lifecycle)}
                className="max-w-[15rem] brightness-125 saturate-[0.85] sm:max-w-[18rem] md:max-w-[22rem]"
              />
              {showLiveTools ? (
                <div className="absolute bottom-6 left-6 right-6 border-t border-white/15 pt-4 sm:left-10 sm:right-10 lg:left-8 lg:right-8">
                  <p className="text-xs font-semibold uppercase tracking-[0.15em] text-pf-light/80">
                    Right now
                  </p>
                  <p className="mt-1 text-sm font-semibold text-white">
                    {activeUpdates === 0
                      ? 'No temporary visitor updates'
                      : `${activeUpdates} visitor update${activeUpdates === 1 ? '' : 's'} live`}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        {secondaryTasks.length ? (
          <section className="mt-9" aria-labelledby="more-actions-heading">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
              Also available
            </p>
            <h2
              id="more-actions-heading"
              className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep"
            >
              More from Torchiko
            </h2>
            <ol className="mt-5 border-y border-pf-light" aria-label="Torchiko tasks">
              {secondaryTasks.map((task, index) => (
                <li key={task.id} className="border-b border-pf-light last:border-b-0">
                  <PortalActionLink
                    href={task.href}
                    className="group grid gap-2 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:items-start sm:gap-4"
                  >
                    <span className="text-xs font-semibold tracking-[0.12em] text-pf-primary/65">
                      {String(index + 2).padStart(2, '0')}
                    </span>
                    <span>
                      <span className="flex flex-wrap items-center gap-2">
                        <strong className="text-pf-deep">{task.title}</strong>
                        {task.required ? (
                          <span className="text-xs font-semibold text-amber-800">
                            Action needed
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 block text-sm leading-6 text-pf-deep/70">
                        {task.description}
                      </span>
                      {task.items?.length ? (
                        <span className="mt-2 block text-sm text-pf-deep/75">
                          {task.items.join(' · ')}
                          {task.additionalItemCount ? ` · ${task.additionalItemCount} more` : ''}
                        </span>
                      ) : null}
                    </span>
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-pf-primary group-hover:text-pf-deep">
                      Open <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </PortalActionLink>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {showLiveTools ? (
          <section className="mt-12" aria-labelledby="manage-heading">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
              Keep it current
            </p>
            <h2
              id="manage-heading"
              className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep"
            >
              The essentials
            </h2>
            <div className="mt-5 grid border-y border-pf-light md:grid-cols-3">
              {[
                {
                  href: '/operational-updates',
                  title: 'Visitor updates',
                  body: 'Share a closure, event, parking change, or temporary notice.',
                  Icon: Megaphone,
                },
                {
                  href: '/ai-controls',
                  title: 'Visitor experience',
                  body: 'Choose the voice that feels right for your visitors.',
                  Icon: Sparkles,
                },
                {
                  href: '/support',
                  title: 'Help & changes',
                  body: 'Ask a question or request a change from the Torchiko team.',
                  Icon: Headphones,
                },
              ].map(({ href, title, body, Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className="group border-b border-pf-light py-6 last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent md:border-b-0 md:border-r md:px-6 md:first:pl-0 md:last:border-r-0 md:last:pr-0"
                >
                  <Icon className="h-5 w-5 text-pf-primary" aria-hidden="true" />
                  <h3 className="mt-5 text-lg font-semibold text-pf-deep">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-pf-deep/70">{body}</p>
                  <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-pf-primary group-hover:text-pf-deep">
                    Open <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        {secondLayer?.enabled ? (
          <div className="mt-10">
            <SecondLayerSettings
              venueId={venue.id}
              enabled={secondLayer.enabled}
              initialLabel={secondLayer.label}
              initialUrl={secondLayer.url}
              initialUpdatedAt={secondLayer.updatedAt}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
