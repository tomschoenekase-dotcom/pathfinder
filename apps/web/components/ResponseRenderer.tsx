'use client'

import { useId } from 'react'
import { AlertTriangle, CalendarDays, CheckCircle2, ExternalLink, Info, MapPin } from 'lucide-react'
import {
  legacyGuestResponseToBlocks,
  type GuestResponseBlock,
  type GuestResponsePlace,
  type GuestVisitorAction,
} from '@pathfinder/contracts/guest-response'

import { PlaceCard } from './PlaceCard'

type ResponseRendererProps = {
  content: string
  blocks?: GuestResponseBlock[]
  places?: GuestResponsePlace[]
  onPlaceCardClick?: (placeId: string) => void
  onPlaceCardView?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
  onChoiceSelect?: (value: string) => void
  onVisitorAction?: (action: GuestVisitorAction) => void
}

function safeHttpsHref(href: string): string | null {
  try {
    const parsed = new URL(href)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
    const sensitiveKey =
      /(?:token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-)/iu
    const keys = [
      ...parsed.searchParams.keys(),
      ...new URLSearchParams(parsed.hash.slice(1)).keys(),
    ]
    return keys.some((key) => sensitiveKey.test(key)) ? null : parsed.toString()
  } catch {
    return null
  }
}

function eventDateTime(value: string, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(new Date(value))
  } catch {
    return new Date(value).toLocaleString()
  }
}

function safeWebHref(href: string): string | null {
  try {
    const parsed = new URL(href)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function PlaceGrid({
  places,
  onPlaceCardClick,
  onPlaceCardView,
  onDirectionsClick,
}: Pick<
  ResponseRendererProps,
  'places' | 'onPlaceCardClick' | 'onPlaceCardView' | 'onDirectionsClick'
>) {
  if (!places?.length) return null

  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-label="Recommended places">
      {places.map((place) => (
        <PlaceCard
          key={place.id}
          id={place.id}
          name={place.name}
          type={place.type}
          photoUrl={place.photoUrl}
          shortDescription={place.shortDescription}
          areaName={place.areaName}
          hours={place.hours}
          distanceMeters={place.distanceMeters}
          lat={place.lat}
          lng={place.lng}
          {...(onPlaceCardClick ? { onCardClick: onPlaceCardClick } : {})}
          {...(onPlaceCardView ? { onView: onPlaceCardView } : {})}
          {...(onDirectionsClick ? { onDirectionsClick } : {})}
        />
      ))}
    </div>
  )
}

export function ResponseRenderer({
  content,
  blocks,
  places,
  onPlaceCardClick,
  onPlaceCardView,
  onDirectionsClick,
  onChoiceSelect,
  onVisitorAction,
}: ResponseRendererProps) {
  const citationsHeadingId = useId()
  const sectionHeadingId = useId()
  const renderedBlocks: GuestResponseBlock[] = blocks?.length
    ? blocks
    : legacyGuestResponseToBlocks({ content, ...(places ? { places } : {}) })

  return (
    <div className="space-y-3" data-response-format={blocks?.length ? 'structured' : 'legacy'}>
      {renderedBlocks.map((block, index) => {
        switch (block.type) {
          case 'text':
            return (
              <p key={index} className="whitespace-pre-wrap break-words" lang="" dir="auto">
                {block.text}
              </p>
            )
          case 'callout': {
            const Icon =
              block.tone === 'warning'
                ? AlertTriangle
                : block.tone === 'success'
                  ? CheckCircle2
                  : Info
            const toneClass =
              block.tone === 'warning'
                ? 'border-amber-300 bg-amber-50 text-amber-950'
                : block.tone === 'success'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
                  : 'border-[var(--chat-border)] bg-[var(--chat-bg)] text-[var(--chat-text)]'
            return (
              <aside key={index} className={`rounded-2xl border p-3 ${toneClass}`}>
                <div className="flex gap-2.5">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    {block.title ? <p className="font-semibold">{block.title}</p> : null}
                    <p className="whitespace-pre-wrap text-sm leading-5" lang="" dir="auto">
                      {block.text}
                    </p>
                  </div>
                </div>
              </aside>
            )
          }
          case 'actions':
            return (
              <div key={index} className="flex flex-wrap gap-2" aria-label="Response actions">
                {block.actions.map((action) => {
                  if ('href' in action) {
                    const href = safeWebHref(action.href)
                    return href ? (
                      <a
                        key={`${action.label}-${href}`}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-flex min-h-10 items-center rounded-full px-4 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chat-accent)] focus-visible:ring-offset-2 ${
                          action.style === 'primary'
                            ? 'bg-[var(--chat-accent)] text-[var(--chat-accent-contrast)] hover:opacity-90'
                            : 'border border-[var(--chat-border)] bg-[var(--chat-bg)] text-[var(--chat-accent-text)] hover:border-[var(--chat-accent)]'
                        }`}
                      >
                        {action.label}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : null
                  }
                  if (action.permissionRequirement !== 'PUBLIC') return null
                  const href =
                    action.target.kind === 'URL'
                      ? safeHttpsHref(action.target.url)
                      : action.target.kind === 'PHONE'
                        ? `tel:${action.target.phone}`
                        : action.fallbackUrl
                          ? safeHttpsHref(action.fallbackUrl)
                          : null
                  const activate = () => {
                    if (
                      action.confirmationRequired &&
                      !window.confirm(`Continue with “${action.label}”?`)
                    )
                      return
                    onVisitorAction?.(action)
                  }
                  const actionClass = `inline-flex min-h-10 items-center rounded-full px-4 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chat-accent)] focus-visible:ring-offset-2 ${
                    action.style === 'primary'
                      ? 'bg-[var(--chat-accent)] text-[var(--chat-accent-contrast)] hover:opacity-90'
                      : 'border border-[var(--chat-border)] bg-[var(--chat-bg)] text-[var(--chat-accent-text)] hover:border-[var(--chat-accent)]'
                  }`
                  return href ? (
                    <a
                      key={action.analyticsKey}
                      href={href}
                      {...(href.startsWith('https:')
                        ? { target: '_blank', rel: 'noopener noreferrer' }
                        : {})}
                      className={actionClass}
                      onClick={(event) => {
                        if (
                          action.confirmationRequired &&
                          !window.confirm(`Continue with “${action.label}”?`)
                        ) {
                          event.preventDefault()
                          return
                        }
                        onVisitorAction?.(action)
                      }}
                    >
                      {action.label}
                      {href.startsWith('https:') ? (
                        <span className="sr-only"> (opens in a new tab)</span>
                      ) : null}
                    </a>
                  ) : onVisitorAction ? (
                    <button
                      key={action.analyticsKey}
                      type="button"
                      className={actionClass}
                      onClick={activate}
                    >
                      {action.label}
                    </button>
                  ) : null
                })}
              </div>
            )
          case 'citations':
            return (
              <section
                key={index}
                aria-labelledby={`${citationsHeadingId}-${index}`}
                className="border-t border-[var(--chat-border)] pt-3"
              >
                <h3
                  id={`${citationsHeadingId}-${index}`}
                  className="text-xs font-semibold uppercase tracking-wide text-[var(--chat-text-muted)]"
                >
                  Sources
                </h3>
                <ol className="mt-2 space-y-1.5 text-xs text-[var(--chat-text-muted)]">
                  {block.citations.map((citation, citationIndex) => {
                    const href = citation.href ? safeWebHref(citation.href) : null
                    return (
                      <li key={`${citation.label}-${citationIndex}`}>
                        <span className="mr-1" aria-hidden="true">
                          {citationIndex + 1}.
                        </span>
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-[var(--chat-accent-text)] underline decoration-current/30 underline-offset-2 hover:decoration-current"
                          >
                            {citation.label}
                            <span className="sr-only"> (opens in a new tab)</span>
                          </a>
                        ) : (
                          <span className="font-medium text-[var(--chat-text)]">
                            {citation.label}
                          </span>
                        )}
                        {citation.detail ? <span> — {citation.detail}</span> : null}
                      </li>
                    )
                  })}
                </ol>
              </section>
            )
          case 'places':
            return (
              <PlaceGrid
                key={index}
                places={block.places}
                {...(onPlaceCardClick ? { onPlaceCardClick } : {})}
                {...(onPlaceCardView ? { onPlaceCardView } : {})}
                {...(onDirectionsClick ? { onDirectionsClick } : {})}
              />
            )
          case 'choices':
            return (
              <section key={index} aria-labelledby={`${sectionHeadingId}-choices-${index}`}>
                <h3
                  id={`${sectionHeadingId}-choices-${index}`}
                  className="text-sm font-semibold text-[var(--chat-text)]"
                >
                  {block.label}
                </h3>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {block.choices.map((choice) => (
                    <li key={choice.id}>
                      {onChoiceSelect ? (
                        <button
                          type="button"
                          aria-label={choice.accessibleLabel ?? choice.label}
                          className="min-h-11 rounded-full border border-[var(--chat-border)] bg-[var(--chat-card)] px-4 py-2 text-sm font-semibold text-[var(--chat-accent-text)] transition hover:border-[var(--chat-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chat-accent)] focus-visible:ring-offset-2"
                          onClick={() => onChoiceSelect(choice.value)}
                        >
                          {choice.label}
                        </button>
                      ) : (
                        <span className="inline-flex min-h-10 items-center rounded-full border border-[var(--chat-border)] px-4 text-sm font-medium">
                          {choice.label}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )
          case 'image': {
            const src = safeHttpsHref(block.image.src)
            return src ? (
              <figure
                key={index}
                className="overflow-hidden rounded-2xl border border-[var(--chat-border)]"
              >
                {/* External response media is deliberately rendered without Next image optimization. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt={block.image.alt}
                  width={block.image.width}
                  height={block.image.height}
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="max-h-80 w-full object-cover"
                />
                {block.image.caption ? (
                  <figcaption className="px-3 py-2 text-xs text-[var(--chat-text-muted)]">
                    {block.image.caption}
                  </figcaption>
                ) : null}
              </figure>
            ) : null
          }
          case 'gallery':
            return (
              <section key={index} aria-labelledby={`${sectionHeadingId}-gallery-${index}`}>
                <h3
                  id={`${sectionHeadingId}-gallery-${index}`}
                  className="text-sm font-semibold text-[var(--chat-text)]"
                >
                  {block.label}
                </h3>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {block.images.map((item, imageIndex) => {
                    const src = safeHttpsHref(item.src)
                    return src ? (
                      <figure
                        key={`${src}-${imageIndex}`}
                        className="overflow-hidden rounded-2xl border border-[var(--chat-border)]"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={src}
                          alt={item.alt}
                          width={item.width}
                          height={item.height}
                          loading="lazy"
                          decoding="async"
                          referrerPolicy="no-referrer"
                          className="h-40 w-full object-cover sm:h-48"
                        />
                        {item.caption ? (
                          <figcaption className="px-3 py-2 text-xs text-[var(--chat-text-muted)]">
                            {item.caption}
                          </figcaption>
                        ) : null}
                      </figure>
                    ) : null
                  })}
                </div>
              </section>
            )
          case 'events':
            return (
              <section key={index} aria-labelledby={`${sectionHeadingId}-events-${index}`}>
                <h3
                  id={`${sectionHeadingId}-events-${index}`}
                  className="text-sm font-semibold text-[var(--chat-text)]"
                >
                  {block.label}
                </h3>
                <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                  {block.events.map((event) => {
                    const href = event.href ? safeHttpsHref(event.href) : null
                    return (
                      <li
                        key={event.id}
                        className="rounded-2xl border border-[var(--chat-border)] bg-[var(--chat-card)] p-3"
                      >
                        <div className="flex gap-2.5">
                          <CalendarDays
                            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--chat-accent)]"
                            aria-hidden="true"
                          />
                          <div className="min-w-0">
                            <p className="font-semibold">{event.title}</p>
                            <p className="mt-1 text-xs text-[var(--chat-text-muted)]">
                              <time dateTime={event.startsAt}>
                                {eventDateTime(event.startsAt, event.timezone)}
                              </time>
                              {event.endsAt ? (
                                <>
                                  {' – '}
                                  <time dateTime={event.endsAt}>
                                    {eventDateTime(event.endsAt, event.timezone)}
                                  </time>
                                </>
                              ) : null}
                              {event.timezone ? ` (${event.timezone})` : null}
                            </p>
                            {event.location ? (
                              <p className="mt-1 text-xs">{event.location}</p>
                            ) : null}
                            {event.description ? (
                              <p className="mt-2 text-sm">{event.description}</p>
                            ) : null}
                            {href ? (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-2 inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-[var(--chat-accent-text)] underline underline-offset-2"
                              >
                                Event details{' '}
                                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                                <span className="sr-only"> (opens in a new tab)</span>
                              </a>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          case 'location': {
            const href = safeHttpsHref(block.mapHref)
            return href ? (
              <section
                key={index}
                className="rounded-2xl border border-[var(--chat-border)] bg-[var(--chat-card)] p-3"
              >
                <div className="flex gap-2.5">
                  <MapPin
                    className="mt-0.5 h-4 w-4 shrink-0 text-[var(--chat-accent)]"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <h3 className="font-semibold">{block.name}</h3>
                    {block.address ? <p className="mt-1 text-sm">{block.address}</p> : null}
                    {block.detail ? (
                      <p className="mt-1 text-xs text-[var(--chat-text-muted)]">{block.detail}</p>
                    ) : null}
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-[var(--chat-accent-text)] underline underline-offset-2"
                    >
                      Open map link <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </div>
                </div>
              </section>
            ) : null
          }
        }
      })}
    </div>
  )
}
