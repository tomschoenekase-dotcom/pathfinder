'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { useOrganization } from '@clerk/nextjs'
import {
  ArrowRight,
  ArrowUpRight,
  Headphones,
  MessageCircleHeart,
  Megaphone,
  QrCode,
  Sparkles,
} from 'lucide-react'

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
  visitorPulse?: {
    windowDays: number
    conversationCount: number
    feedback: { helpful: number; notHelpful: number }
  } | null
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

export function DashboardOverview(props: DashboardOverviewProps) {
  const { organization } = useOrganization()
  return <DashboardOverviewView {...props} organizationName={organization?.name} />
}

export function DashboardOverviewView({
  venue,
  venues,
  activeUpdates,
  chatUrl,
  impersonatedTenantName,
  tasks,
  visitorPulse,
  secondLayer,
  organizationName,
}: DashboardOverviewProps & { organizationName?: string | undefined }) {
  const orgName = impersonatedTenantName ?? organizationName ?? venue.name
  const lifecycle = venue.lifecycle
  const clientPreview = venue.clientPreview ?? { state: 'UNAVAILABLE' as const, id: null }
  const showLiveTools = lifecycle.state === 'LIVE' || lifecycle.state === 'PAUSED'
  const publicGuestLinkAvailable =
    lifecycle.state === 'READY' || lifecycle.state === 'LIVE' || lifecycle.state === 'REVISIONS'
  const previewHref =
    lifecycle.state === 'CLIENT_PREVIEW' && clientPreview.state === 'AVAILABLE' && clientPreview.id
      ? `/venues/${encodeURIComponent(venue.id)}/preview/${encodeURIComponent(clientPreview.id)}`
      : null
  const action =
    lifecycle.clientAction === 'CONTINUE_INTAKE'
      ? { href: `/venues/${encodeURIComponent(venue.id)}/onboarding`, label: 'Continue setup' }
      : lifecycle.clientAction === 'CONTACT_SUPPORT'
        ? {
            href: `/support?venue=${encodeURIComponent(venue.id)}`,
            label: 'Contact Support',
          }
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
  const primaryTaskOpensGuide = Boolean(primaryTask && chatUrl && primaryTask.href === chatUrl)
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

        <section
          className="mt-6 border-y border-pf-light bg-white px-5 py-5 sm:px-7"
          aria-labelledby="venue-status-heading"
        >
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-pf-primary">
                {lifecycle.label}
              </p>
              <h2
                id="venue-status-heading"
                className="mt-1.5 text-xl font-semibold tracking-tight text-pf-deep sm:text-2xl"
              >
                {lifecycle.headline}
              </h2>
              <p className="mt-2 text-sm leading-6 text-pf-deep/75">{lifecycle.summary}</p>
              {primaryTask ? (
                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-pf-primary">
                    {primaryTask.required ? 'Your next step' : 'Available now'}
                  </p>
                  {primaryTask.items?.length ? (
                    <p className="mt-1 text-sm leading-6 text-pf-deep/75">
                      {primaryTask.items.slice(0, 2).join(' · ')}
                      {primaryTask.additionalItemCount
                        ? ` · ${primaryTask.additionalItemCount} more in Help & changes`
                        : ''}
                    </p>
                  ) : null}
                  <PortalActionLink
                    href={primaryTask.href}
                    className="mt-2 inline-flex min-h-11 items-center gap-2 bg-pf-primary px-4 text-sm font-semibold text-white hover:bg-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
                  >
                    {primaryTaskOpensGuide ? 'Open visitor guide' : primaryTask.title}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </PortalActionLink>
                </div>
              ) : previewUnavailable ? (
                <p
                  className="mt-4 border-l-2 border-pf-accent pl-3 text-sm leading-6 text-pf-deep/75"
                  role="status"
                >
                  {clientPreview.state === 'SUPERSEDED'
                    ? 'An updated preview is being prepared. We will make it available here when it is ready.'
                    : 'This preview is temporarily unavailable. Torchiko will make a reviewed preview available here when it is ready.'}
                </p>
              ) : !chatUrl || !publicGuestLinkAvailable ? (
                <p className="mt-4 text-sm font-medium text-pf-deep/75">
                  Nothing you need to do right now.
                </p>
              ) : null}
              {showLiveTools ? (
                <p
                  className="mt-4 border-t border-pf-light pt-3 text-sm font-medium text-pf-deep/75"
                  role="status"
                >
                  {activeUpdates === 0
                    ? 'No temporary visitor updates'
                    : `${activeUpdates} visitor update${activeUpdates === 1 ? '' : 's'} live`}
                </p>
              ) : null}
            </div>

            {chatUrl && publicGuestLinkAvailable ? (
              <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">
                {!primaryTaskOpensGuide ? (
                  <a
                    href={chatUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center justify-center gap-2 bg-pf-primary px-4 text-sm font-semibold text-white hover:bg-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
                  >
                    Open visitor guide <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                ) : null}
                <Link
                  href={`/venues/${encodeURIComponent(venue.id)}/qr-kit`}
                  className="inline-flex min-h-11 items-center justify-center gap-2 border border-pf-light px-4 text-sm font-semibold text-pf-deep hover:border-pf-primary hover:text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
                >
                  <QrCode className="h-4 w-4" aria-hidden="true" />
                  QR / print materials
                </Link>
              </div>
            ) : null}
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
          <section className="mt-12" aria-labelledby="visitor-pulse-heading">
            <div className="grid gap-6 border-y border-pf-light py-7 md:grid-cols-[minmax(0,1.35fr)_minmax(17rem,0.65fr)] md:items-center">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
                  Visitor pulse
                </p>
                <h2
                  id="visitor-pulse-heading"
                  className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep"
                >
                  A useful view, without visitor profiles
                </h2>
                {visitorPulse &&
                (visitorPulse.conversationCount > 0 ||
                  visitorPulse.feedback.helpful + visitorPulse.feedback.notHelpful > 0) ? (
                  <dl className="mt-5 grid grid-cols-2 gap-4 sm:max-w-lg">
                    <div>
                      <dt className="text-sm leading-6 text-pf-deep/65">Visitor conversations</dt>
                      <dd className="mt-1 text-3xl font-semibold tracking-tight text-pf-deep">
                        {visitorPulse.conversationCount.toLocaleString()}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-sm leading-6 text-pf-deep/65">Helpful ratings</dt>
                      <dd className="mt-1 text-3xl font-semibold tracking-tight text-pf-deep">
                        {visitorPulse.feedback.helpful.toLocaleString()}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-4 max-w-2xl text-sm leading-6 text-pf-deep/70">
                    A privacy-safe summary will appear here as visitors use Torchiko and choose to
                    rate answers.
                  </p>
                )}
                <p className="mt-4 max-w-2xl text-xs leading-5 text-pf-deep/70">
                  Last {visitorPulse?.windowDays ?? 30} days. This summary does not expose visitor
                  identities, locations, or conversation transcripts.
                </p>
              </div>
              <div className="md:border-l md:border-pf-light md:pl-7">
                <MessageCircleHeart className="h-6 w-6 text-pf-primary" aria-hidden="true" />
                <h3 className="mt-4 text-lg font-semibold text-pf-deep">
                  Something needs attention?
                </h3>
                <p className="mt-2 text-sm leading-6 text-pf-deep/70">
                  Tell the Torchiko team what you noticed. We’ll review the visitor experience and
                  handle the change with you.
                </p>
                <Link
                  href={`/support?venue=${encodeURIComponent(venue.id)}&new=visitor-insight`}
                  className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-pf-primary hover:text-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                >
                  Ask for a review <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
            </div>
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
                  href: `/ai-controls?venue=${encodeURIComponent(venue.id)}`,
                  title: 'Visitor experience',
                  body: 'Choose the voice that feels right for your visitors.',
                  Icon: Sparkles,
                },
                {
                  href: `/support?venue=${encodeURIComponent(venue.id)}`,
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
