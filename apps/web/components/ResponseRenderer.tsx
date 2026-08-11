'use client'

import { useId } from 'react'
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import type { GuestResponseBlock, GuestResponsePlace } from '@pathfinder/contracts/guest-response'

import { PlaceCard } from './PlaceCard'

type ResponseRendererProps = {
  content: string
  blocks?: GuestResponseBlock[]
  places?: GuestResponsePlace[]
  onPlaceCardClick?: (placeId: string) => void
  onPlaceCardView?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
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
}: ResponseRendererProps) {
  const citationsHeadingId = useId()
  const renderedBlocks: GuestResponseBlock[] = blocks?.length
    ? blocks
    : [
        ...(content.trim() ? [{ type: 'text' as const, text: content }] : []),
        ...(places?.length ? [{ type: 'places' as const, places }] : []),
      ]

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
                          : 'border border-[var(--chat-border)] bg-[var(--chat-bg)] text-[var(--chat-accent)] hover:border-[var(--chat-accent)]'
                      }`}
                    >
                      {action.label}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
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
                            className="font-medium text-[var(--chat-accent)] underline decoration-current/30 underline-offset-2 hover:decoration-current"
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
        }
      })}
    </div>
  )
}
