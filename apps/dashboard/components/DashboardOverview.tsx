'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { useOrganization } from '@clerk/nextjs'
import { ArrowRight, ArrowUpRight, Check, QrCode } from 'lucide-react'

import type {
  ClientPortalLifecycle,
  ClientPortalLifecycleView,
} from '@pathfinder/contracts/client-portal-lifecycle'
import { CopyAccessValueButton } from './CopyAccessValueButton'
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
  distributionReadback?: {
    website: {
      effective: boolean
      reason: string | null
      framed: boolean
      frameReason: string | null
      origins: readonly string[]
    }
    app: { effective: boolean; reason: string | null }
    revision: number
    sessions30d: { direct: number; qr: number; website: number; app: number; unknown: number }
    publicUrl: string | null
    appUrl: string | null
    appBackground: string | null
  } | null
}

export type ClientPortalTask = {
  id: string
  kind?: 'information-request' | 'preview' | 'share-information' | 'progress' | 'report'
  title: string
  description: string
  href: string
  required: boolean
  items?: string[]
  additionalItemCount?: number
}

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus focus-visible:ring-offset-2 focus-visible:ring-offset-tk-paper'

// The home shows where a venue is on one short trail, not the internal lifecycle.
const GUIDE_STOPS = ['Share information', 'Torchiko builds', 'You preview', 'Live'] as const

function guideStop(state: ClientPortalLifecycle): number | null {
  switch (state) {
    case 'SETUP_REQUESTED':
    case 'COLLECTING':
      return 0
    case 'PROCESSING':
    case 'INTERNAL_REVIEW':
      return 1
    case 'CLIENT_PREVIEW':
    case 'READY':
      return 2
    case 'LIVE':
    case 'REVISIONS':
    case 'PAUSED':
      return 3
    default:
      return null
  }
}

function surfaceStatus(effective: boolean, reason: string | null) {
  if (effective) return 'Switched on'
  if (reason === 'VENUE_INACTIVE') return 'Available once your guide is live'
  if (reason === 'NO_ORIGINS') return 'Torchiko needs your website address first'
  return 'Not switched on for your venue yet'
}

function PortalActionLink({
  href,
  className,
  children,
  describedBy,
}: {
  href: string
  className: string
  children: ReactNode
  describedBy?: string
}) {
  return /^https?:\/\//u.test(href) ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      aria-describedby={describedBy}
    >
      {children}
    </a>
  ) : (
    <Link href={href} className={className} aria-describedby={describedBy}>
      {children}
    </Link>
  )
}

function askAction(task: ClientPortalTask, opensGuide: boolean) {
  if (opensGuide) return 'Open visitor guide'
  if (task.id === 'additional-support-questions') return 'See the other questions'
  if (task.id === 'contact_support') return 'Contact Support'
  if (task.kind === 'information-request') return 'Send these details'
  if (task.kind === 'share-information') return 'Share what you have'
  if (task.kind === 'preview') return 'Open preview'
  return task.title
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
  distributionReadback,
  organizationName,
}: DashboardOverviewProps & { organizationName?: string | undefined }) {
  const orgName = impersonatedTenantName ?? organizationName ?? venue.name
  const venueQuery = encodeURIComponent(venue.id)
  const lifecycle = venue.lifecycle
  const clientPreview = venue.clientPreview ?? { state: 'UNAVAILABLE' as const, id: null }
  const showLiveTools = lifecycle.state === 'LIVE' || lifecycle.state === 'PAUSED'
  const publicGuestLinkAvailable =
    lifecycle.state === 'READY' || lifecycle.state === 'LIVE' || lifecycle.state === 'REVISIONS'
  const guideLink = chatUrl && publicGuestLinkAvailable ? chatUrl : null
  const shareableLink = guideLink ? (distributionReadback?.publicUrl ?? guideLink) : null
  const previewHref =
    lifecycle.state === 'CLIENT_PREVIEW' && clientPreview.state === 'AVAILABLE' && clientPreview.id
      ? `/venues/${venueQuery}/preview/${encodeURIComponent(clientPreview.id)}`
      : null
  const previewUnavailable =
    lifecycle.state === 'CLIENT_PREVIEW' && clientPreview.state !== 'AVAILABLE'

  const lifecycleTask: ClientPortalTask | null = previewHref
    ? {
        id: 'preview',
        kind: 'preview',
        title: 'Review the visitor experience',
        description: lifecycle.summary,
        href: previewHref,
        required: true,
      }
    : lifecycle.clientAction === 'CONTINUE_INTAKE'
      ? {
          id: 'continue_intake',
          kind: 'share-information',
          title: 'Continue setup',
          description: lifecycle.summary,
          href: `/venues/${venueQuery}/onboarding`,
          required: true,
        }
      : lifecycle.clientAction === 'CONTACT_SUPPORT'
        ? {
            id: 'contact_support',
            title: 'Tell Torchiko if visitors should be able to use the guide',
            description: lifecycle.summary,
            href: `/support?venue=${venueQuery}`,
            required: true,
          }
        : lifecycle.state !== 'CLIENT_PREVIEW' &&
            lifecycle.clientAction === 'OPEN_PREVIEW' &&
            chatUrl
          ? {
              id: 'open-visitor-experience',
              kind: 'preview',
              title: 'Open visitor experience',
              description: lifecycle.summary,
              href: chatUrl,
              required: true,
            }
          : null
  const serverTasks = tasks ?? (lifecycleTask ? [lifecycleTask] : [])
  const asks = serverTasks.filter((task) => task.required)
  // A paused venue must always see its support route, even when the server
  // evidence carries no explicit task for it.
  if (
    lifecycle.clientAction === 'CONTACT_SUPPORT' &&
    lifecycleTask &&
    !asks.some((task) => task.href === lifecycleTask.href)
  ) {
    asks.push(lifecycleTask)
  }
  const optional = serverTasks.filter((task) => !task.required)
  const informationRequests = asks.filter((task) => task.kind === 'information-request')

  const stop = guideStop(lifecycle.state)
  // The contract summary is written for a venue with nothing outstanding. When
  // Torchiko has asked for something, say how that ask fits instead of
  // repeating it or claiming that nothing is needed.
  const repeatsAsk = asks.some((task) => task.description === lifecycle.summary)
  const statusSummary: string | null =
    asks.length === 0
      ? lifecycle.state === 'LIVE'
        ? null
        : lifecycle.summary
      : lifecycle.state === 'SETUP_REQUESTED' || lifecycle.state === 'COLLECTING'
        ? 'Torchiko handles the setup from whatever you share.'
        : lifecycle.state === 'CLIENT_PREVIEW' || lifecycle.state === 'READY'
          ? 'When it looks right, the Torchiko team will coordinate launch timing.'
          : informationRequests.length &&
              (lifecycle.state === 'PROCESSING' || lifecycle.state === 'INTERNAL_REVIEW')
            ? 'The details above are what Torchiko needs to finish. Everything else is underway.'
            : repeatsAsk
              ? null
              : lifecycle.summary
  const pulseHasActivity = Boolean(
    visitorPulse &&
    (visitorPulse.conversationCount > 0 ||
      visitorPulse.feedback.helpful + visitorPulse.feedback.notHelpful > 0),
  )
  const justLaunched = lifecycle.state === 'LIVE' && Boolean(visitorPulse) && !pulseHasActivity
  const arrivals = distributionReadback
    ? [
        { label: 'QR code', count: distributionReadback.sessions30d.qr },
        { label: 'direct link', count: distributionReadback.sessions30d.direct },
        { label: 'your website', count: distributionReadback.sessions30d.website },
        { label: 'your app', count: distributionReadback.sessions30d.app },
        { label: 'other', count: distributionReadback.sessions30d.unknown },
      ].filter((row) => row.count > 0)
    : []

  const alsoHere: Array<{ href: string; title: string; body: string }> = []
  if (showLiveTools) {
    alsoHere.push(
      {
        href: '/operational-updates',
        title: 'Visitor updates',
        body: 'Post a closure, event, parking change, or other temporary notice.',
      },
      {
        href: `/ai-controls?venue=${venueQuery}`,
        title: 'Visitor experience',
        body: 'Adjust how the guide greets and speaks to visitors.',
      },
    )
  }
  for (const task of optional) {
    alsoHere.push({
      href: task.href,
      title: task.kind === 'progress' ? 'See what Torchiko is working on' : task.title,
      body:
        task.kind === 'progress'
          ? 'What is ready, what is being checked, and anything waiting on you.'
          : task.description,
    })
  }
  alsoHere.push({
    href: `/support?venue=${venueQuery}`,
    title: 'Help & changes',
    body: 'Ask a question or request a change from the Torchiko team.',
  })

  return (
    <div className="min-h-screen bg-tk-paper text-tk-ink">
      <div className="mx-auto max-w-5xl px-4 pb-16 pt-7 sm:px-8 sm:pt-10 lg:px-12 lg:pt-14">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <h1 className="text-[1.9rem] font-semibold leading-tight tracking-[-0.03em] sm:text-4xl">
            {orgName}
          </h1>
          {venues.length > 1 ? (
            <div className="min-w-48">
              <label htmlFor="portal-venue" className="mb-1 block text-xs font-medium text-tk-soft">
                Viewing venue
              </label>
              <select
                id="portal-venue"
                value={venue.id}
                onChange={(event) => {
                  window.location.href = `/?venue=${encodeURIComponent(event.currentTarget.value)}`
                }}
                className={`min-h-11 w-full border-b-2 border-tk-rule bg-transparent px-1 text-sm font-semibold ${focusRing}`}
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

        {/* 1. What Torchiko needs from the venue — always answered, even when the answer is nothing. */}
        <section className="mt-8 sm:mt-10" aria-labelledby="needs-heading">
          {asks.length ? (
            <>
              <h2 id="needs-heading" className="text-xl font-semibold tracking-tight sm:text-2xl">
                {asks.length === 1
                  ? 'One thing Torchiko needs from you'
                  : `${asks.length} things Torchiko needs from you`}
              </h2>
              <ol className="mt-4 border-t border-tk-rule" aria-label="Torchiko tasks">
                {asks.map((task, index) => {
                  const opensGuide = Boolean(chatUrl && task.href === chatUrl)
                  const titleId = `ask-${index}-title`
                  return (
                    <li
                      key={task.id}
                      className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 border-b border-tk-rule py-5 sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:items-start sm:gap-x-5"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-0.5 flex h-7 w-5 items-center justify-center rounded-[3px] bg-tk-ember text-xs font-bold text-white sm:w-6"
                      >
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <h3 id={titleId} className="text-base font-semibold leading-6 sm:text-lg">
                          {task.title}
                        </h3>
                        {task.items?.length ? (
                          <ul className="mt-2 space-y-1 text-sm leading-6 text-tk-ink">
                            {task.items.map((item) => (
                              <li key={item} className="flex gap-2">
                                <span aria-hidden="true" className="text-tk-soft">
                                  –
                                </span>
                                <span>{item}</span>
                              </li>
                            ))}
                            {task.additionalItemCount ? (
                              <li className="text-tk-soft">
                                and {task.additionalItemCount} more in Help & changes
                              </li>
                            ) : null}
                          </ul>
                        ) : (
                          <p className="mt-1 text-sm leading-6 text-tk-soft">{task.description}</p>
                        )}
                      </div>
                      <div className="col-start-2 mt-3 sm:col-start-3 sm:mt-0">
                        <PortalActionLink
                          href={task.href}
                          describedBy={titleId}
                          className={`inline-flex min-h-11 items-center gap-2 rounded-md bg-tk-ink px-4 text-sm font-semibold text-white hover:bg-tk-focus ${focusRing}`}
                        >
                          {askAction(task, opensGuide)}
                          {opensGuide ? (
                            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <ArrowRight className="h-4 w-4" aria-hidden="true" />
                          )}
                        </PortalActionLink>
                      </div>
                    </li>
                  )
                })}
              </ol>
              {informationRequests.length ? (
                <p className="mt-3 max-w-2xl text-sm leading-6 text-tk-soft">
                  A quick note, a link, or a phone photo is plenty. Torchiko turns your answer into
                  visitor guidance and checks it before visitors see anything new.
                </p>
              ) : null}
            </>
          ) : previewUnavailable ? (
            <>
              <h2 id="needs-heading" className="text-xl font-semibold tracking-tight sm:text-2xl">
                Nothing needed from you yet
              </h2>
              <p
                className="mt-3 max-w-2xl border-l-2 border-tk-ember pl-3 text-sm leading-6 text-tk-ink"
                role="status"
              >
                {clientPreview.state === 'SUPERSEDED'
                  ? 'An updated preview is being prepared. We will make it available here when it is ready.'
                  : 'This preview is temporarily unavailable. Torchiko will make a reviewed preview available here when it is ready.'}
              </p>
            </>
          ) : (
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-tk-moss text-white"
              >
                <Check className="h-3.5 w-3.5" strokeWidth={3} />
              </span>
              <div>
                <h2 id="needs-heading" className="text-xl font-semibold tracking-tight sm:text-2xl">
                  Nothing you need to do right now.
                </h2>
                <p className="mt-1 text-sm leading-6 text-tk-soft">
                  When Torchiko needs a detail or a decision from you, it will be listed here.
                </p>
              </div>
            </div>
          )}
        </section>

        {/* 2. Where the guide stands, and — once public — its link and QR code. */}
        <section className="mt-10 sm:mt-12" aria-labelledby="guide-heading">
          <div className="border-t-2 border-tk-ink pt-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <h2 id="guide-heading" className="text-lg font-semibold tracking-tight sm:text-xl">
                Your visitor guide
              </h2>
              <p className="text-sm font-semibold text-tk-ember-text">{lifecycle.label}</p>
            </div>

            {stop !== null ? (
              <ol className="mt-5 grid grid-cols-4" aria-label="Guide progress">
                {GUIDE_STOPS.map((label, index) => {
                  const status = index < stop ? 'done' : index === stop ? 'current' : 'upcoming'
                  return (
                    <li
                      key={label}
                      className="relative flex flex-col items-start"
                      aria-current={status === 'current' ? 'step' : undefined}
                    >
                      <span className="flex w-full items-center" aria-hidden="true">
                        <span
                          className={[
                            'h-4 w-2.5 shrink-0 rounded-[2px]',
                            status === 'done'
                              ? 'bg-tk-ink'
                              : status === 'current'
                                ? lifecycle.state === 'PAUSED'
                                  ? 'border-2 border-tk-ember bg-tk-paper'
                                  : 'bg-tk-ember ring-4 ring-tk-ember/20'
                                : 'border border-tk-soft/60 bg-tk-paper',
                          ].join(' ')}
                        />
                        {index < GUIDE_STOPS.length - 1 ? (
                          <span
                            className={`mx-1.5 h-px flex-1 ${index < stop ? 'bg-tk-ink' : 'bg-tk-rule'}`}
                          />
                        ) : null}
                      </span>
                      <span
                        className={`mt-2 pr-2 text-xs leading-4 sm:text-sm ${status === 'upcoming' ? 'text-tk-soft' : 'font-semibold text-tk-ink'}`}
                      >
                        {label}
                        <span className="sr-only">
                          {status === 'done'
                            ? ' (done)'
                            : status === 'current'
                              ? ' (current step)'
                              : ' (not started)'}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ol>
            ) : null}

            <p className="mt-5 max-w-2xl text-base font-medium leading-7">{lifecycle.headline}</p>
            {statusSummary ? (
              <p className="mt-1 max-w-2xl text-sm leading-6 text-tk-soft">{statusSummary}</p>
            ) : null}

            {guideLink && shareableLink ? (
              <div className="mt-6 grid gap-6 rounded-lg bg-white p-5 ring-1 ring-tk-rule sm:p-6 md:grid-cols-[minmax(0,1fr)_minmax(14rem,auto)] md:gap-10">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">Visitor link</h3>
                  <p className="mt-2 break-all font-mono text-[0.8rem] leading-5 text-tk-ink">
                    {shareableLink}
                  </p>
                  <div className="mt-3 flex flex-wrap items-start gap-2">
                    <CopyAccessValueButton label="link" value={shareableLink} />
                    <a
                      href={guideLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-tk-focus underline-offset-4 hover:underline ${focusRing}`}
                    >
                      Open visitor guide <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                    </a>
                  </div>
                </div>
                <div className="border-t border-tk-rule pt-5 md:border-l md:border-t-0 md:pl-8 md:pt-0">
                  <h3 className="text-sm font-semibold">QR code for signs</h3>
                  <p id="qr-help" className="mt-2 text-sm leading-6 text-tk-soft">
                    Download a print-ready file or print it straight from your browser.
                  </p>
                  <Link
                    href={`/venues/${venueQuery}/qr-kit`}
                    aria-describedby="qr-help"
                    className={`mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border border-tk-ink px-4 text-sm font-semibold hover:bg-tk-ink hover:text-white ${focusRing}`}
                  >
                    <QrCode className="h-4 w-4" aria-hidden="true" />
                    Open QR code
                  </Link>
                </div>
                {justLaunched ? (
                  <p className="border-t border-tk-rule pt-4 text-sm leading-6 md:col-span-2">
                    <span className="font-semibold">Next: </span>
                    print the QR code for your entrance and front desk, then scan it once with your
                    phone before putting it up.
                  </p>
                ) : null}
              </div>
            ) : null}

            {showLiveTools ? (
              <p className="mt-4 text-sm text-tk-soft" role="status">
                {activeUpdates === 0
                  ? 'No temporary visitor updates'
                  : `${activeUpdates} visitor update${activeUpdates === 1 ? '' : 's'} live`}
                {' · '}
                <Link
                  href="/operational-updates"
                  className={`font-semibold text-tk-focus underline-offset-4 hover:underline ${focusRing}`}
                >
                  {activeUpdates === 0 ? 'Post one' : 'Manage'}
                </Link>
              </p>
            ) : null}

            {guideLink && distributionReadback ? (
              <details className="group mt-5 border-t border-tk-rule pt-3">
                <summary
                  className={`flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-tk-focus [&::-webkit-details-marker]:hidden ${focusRing}`}
                >
                  <ArrowRight
                    className="h-4 w-4 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                  Put the guide on your website or in your app
                </summary>
                <dl className="mt-2 grid gap-4 pb-3 pl-6 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="font-semibold">On your website</dt>
                    <dd className="mt-1 leading-6 text-tk-soft">
                      {distributionReadback.website.effective && distributionReadback.website.framed
                        ? `Switched on for ${distributionReadback.website.origins.join(', ')}`
                        : distributionReadback.website.effective
                          ? surfaceStatus(false, 'NO_ORIGINS')
                          : surfaceStatus(false, distributionReadback.website.reason)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold">In your app</dt>
                    <dd className="mt-1 leading-6 text-tk-soft">
                      {surfaceStatus(
                        distributionReadback.app.effective,
                        distributionReadback.app.reason,
                      )}
                      {distributionReadback.app.effective &&
                      (distributionReadback.appUrl || distributionReadback.appBackground) ? (
                        <span className="mt-2 flex flex-wrap gap-2">
                          {distributionReadback.appUrl ? (
                            <CopyAccessValueButton
                              label="app URL"
                              value={distributionReadback.appUrl}
                            />
                          ) : null}
                          {distributionReadback.appBackground ? (
                            <CopyAccessValueButton
                              label="app background color"
                              value={distributionReadback.appBackground}
                            />
                          ) : null}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                </dl>
                <p className="pb-2 pl-6 text-sm leading-6 text-tk-soft">
                  Want either one?{' '}
                  <Link
                    href={`/support?venue=${venueQuery}`}
                    className={`font-semibold text-tk-focus underline-offset-4 hover:underline ${focusRing}`}
                  >
                    Ask Torchiko in Help & changes
                  </Link>
                  .
                </p>
              </details>
            ) : null}
          </div>
        </section>

        {/* 3. A privacy-bounded look at use, only once visitors can open the guide. */}
        {showLiveTools ? (
          <section className="mt-10 sm:mt-12" aria-labelledby="visitor-pulse-heading">
            <div className="border-t border-tk-rule pt-5">
              <h2 id="visitor-pulse-heading" className="text-lg font-semibold tracking-tight">
                Last {visitorPulse?.windowDays ?? 30} days with visitors
              </h2>
              {visitorPulse && pulseHasActivity ? (
                <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
                  <div>
                    <dt className="text-sm text-tk-soft">Visitor conversations</dt>
                    <dd className="mt-0.5 text-3xl font-semibold tracking-tight">
                      {visitorPulse.conversationCount.toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-tk-soft">Helpful ratings</dt>
                    <dd className="mt-0.5 text-3xl font-semibold tracking-tight">
                      {visitorPulse.feedback.helpful.toLocaleString()}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-2 max-w-2xl text-sm leading-6 text-tk-soft">
                  A privacy-safe summary will appear here as visitors use Torchiko and choose to
                  rate answers.
                </p>
              )}
              {arrivals.length ? (
                <p className="mt-3 text-sm leading-6 text-tk-soft">
                  Visitors arrived by{' '}
                  {arrivals.map((row) => `${row.label} ${row.count.toLocaleString()}`).join(' · ')}
                </p>
              ) : null}
              <p className="mt-3 max-w-2xl text-xs leading-5 text-tk-soft">
                This summary does not expose visitor identities, locations, or conversation
                transcripts. Noticed an answer that needs fixing?{' '}
                <Link
                  href={`/support?venue=${venueQuery}&new=visitor-insight`}
                  className={`font-semibold text-tk-focus underline-offset-4 hover:underline ${focusRing}`}
                >
                  Ask for a review
                </Link>
              </p>
            </div>
          </section>
        ) : null}

        {/* 4. Everything else stays one quiet click away. */}
        <nav className="mt-10 sm:mt-12" aria-labelledby="also-here-heading">
          <div className="border-t border-tk-rule pt-5">
            <h2 id="also-here-heading" className="text-sm font-semibold text-tk-soft">
              Also here
            </h2>
            <ul className="mt-2 grid gap-x-10 sm:grid-cols-2">
              {alsoHere.map((item) => (
                <li key={item.href + item.title} className="border-b border-tk-rule/70">
                  <PortalActionLink
                    href={item.href}
                    className={`group flex items-start justify-between gap-4 py-3.5 ${focusRing}`}
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold group-hover:text-tk-focus">
                        {item.title}
                      </span>
                      <span className="mt-0.5 block text-sm leading-6 text-tk-soft">
                        {item.body}
                      </span>
                    </span>
                    <ArrowRight
                      className="mt-1 h-4 w-4 shrink-0 text-tk-soft group-hover:text-tk-focus"
                      aria-hidden="true"
                    />
                    <span className="sr-only">Open</span>
                  </PortalActionLink>
                </li>
              ))}
            </ul>
          </div>
        </nav>

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
