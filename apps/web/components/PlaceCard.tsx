import { useEffect, useId, useRef, useState } from 'react'
import { ArrowUpRight, Navigation } from 'lucide-react'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'

import { useHostPlaceAction } from './HostPlaceAction'
import { getChatLanguagePresentation } from './LanguagePicker'
import { getVisitorUiCopy } from './visitor-ui-copy'

type PlaceCardProps = {
  id: string
  name: string
  type: string
  photoUrl: string | null
  photoAttribution?: {
    altText: string
    caption: string | null
    sourceName: string
    sourceUrl: string | null
  } | null
  shortDescription: string | null
  areaName: string | null
  hours: string | null
  distanceMeters: number | undefined
  lat: number | null
  lng: number | null
  onCardClick?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
  onView?: (placeId: string) => void
  onImageError?: () => void
  language?: SupportedChatLanguage
}

function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)}m away`
  }
  return `${(meters / 1000).toFixed(1)}km away`
}

export function PlaceCard({
  id,
  name,
  type,
  photoUrl,
  photoAttribution,
  shortDescription,
  areaName,
  hours,
  distanceMeters,
  lat,
  lng,
  onCardClick,
  onDirectionsClick,
  onView,
  onImageError,
  language = 'English',
}: PlaceCardProps) {
  const { place: copy } = getVisitorUiCopy(language)
  const [showDetails, hideDetails, areaLabel, hoursLabel, directionsLabel, directionsTo] = copy
  const presentation = getChatLanguagePresentation(language)
  const hostAction = useHostPlaceAction()
  const [isExpanded, setIsExpanded] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)
  const titleId = useId()
  const detailsId = useId()
  const hasCoordinates =
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lng === 'number' &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  const hasDetails = Boolean(shortDescription || areaName || hours)
  const directionsUrl = hasCoordinates
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
    : null

  useEffect(() => {
    onView?.(id)
  }, [id, onView])

  useEffect(() => {
    const image = imageRef.current
    if (photoUrl && image?.complete && image.naturalWidth === 0) onImageError?.()
  }, [photoUrl, onImageError])

  return (
    <article
      aria-labelledby={titleId}
      lang={presentation.code}
      dir={presentation.direction}
      className="overflow-hidden rounded-3xl border border-[var(--chat-border)] bg-[var(--chat-card)] shadow-sm transition hover:border-[var(--chat-accent)]/40 hover:shadow-md"
    >
      {photoUrl ? (
        <div className="h-36 w-full overflow-hidden bg-[var(--chat-bg)]">
          {/* Controlled, same-origin venue media delivery rechecks current review eligibility. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imageRef}
            src={photoUrl}
            alt={photoAttribution?.altText ?? name}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={onImageError}
            className="h-full w-full object-cover"
          />
        </div>
      ) : null}

      {photoUrl && photoAttribution ? (
        <p className="break-words px-4 pt-2 text-xs text-[var(--chat-text-muted)]">
          {photoAttribution.caption ? `${photoAttribution.caption} · ` : null}
          {photoAttribution.sourceUrl ? (
            <a
              href={photoAttribution.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {photoAttribution.sourceName}
            </a>
          ) : (
            photoAttribution.sourceName
          )}
        </p>
      ) : null}

      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id={titleId} className="truncate font-semibold text-[var(--chat-text)]">
              {name}
            </h3>
            <p className="mt-0.5 text-xs capitalize text-[var(--chat-text-muted)]">
              {type.toLowerCase().replace(/_/g, ' ')}
            </p>
          </div>
          {distanceMeters !== undefined ? (
            <span className="shrink-0 rounded-full bg-[var(--chat-bg)] px-2.5 py-1 text-xs font-semibold text-[var(--chat-accent-text)]">
              {formatDistance(distanceMeters)}
            </span>
          ) : null}
        </div>

        {hasDetails ? (
          <button
            type="button"
            className="mt-3 inline-flex min-h-9 w-full items-center justify-center rounded-full border border-[var(--chat-border)] bg-[var(--chat-bg)] px-4 text-xs font-semibold text-[var(--chat-accent-text)] transition hover:border-[var(--chat-accent)]"
            aria-controls={detailsId}
            aria-expanded={isExpanded}
            onClick={() => {
              setIsExpanded((current) => {
                const next = !current
                if (next) onCardClick?.(id)
                return next
              })
            }}
          >
            {isExpanded ? `${hideDetails} ${name}` : `${showDetails} ${name}`}
          </button>
        ) : null}

        {isExpanded && hasDetails ? (
          <div
            id={detailsId}
            className="mt-3 space-y-2 border-t border-[var(--chat-border)] pt-3 text-sm leading-5 text-[var(--chat-text-muted)]"
          >
            {shortDescription ? <p>{shortDescription}</p> : null}
            {areaName ? (
              <p>
                <span className="font-semibold text-[var(--chat-text)]">{areaLabel}:</span>{' '}
                {areaName}
              </p>
            ) : null}
            {hours ? (
              <p>
                <span className="font-semibold text-[var(--chat-text)]">{hoursLabel}:</span> {hours}
              </p>
            ) : null}
          </div>
        ) : null}

        {hostAction ? (
          <button
            type="button"
            aria-label={`${hostAction.label}: ${name}`}
            className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-[var(--chat-accent)] px-4 text-sm font-semibold text-[var(--chat-accent-contrast)] transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chat-accent)] focus-visible:ring-offset-2"
            onClick={(event) => {
              event.stopPropagation()
              hostAction.onAction({ id, name })
            }}
          >
            <span className="truncate">{hostAction.label}</span>
            <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          </button>
        ) : null}

        {directionsUrl ? (
          <a
            href={directionsUrl}
            aria-label={directionsTo(name)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-full border border-[var(--chat-border)] bg-[var(--chat-bg)] px-4 text-xs font-semibold text-[var(--chat-accent-text)] transition hover:border-[var(--chat-accent)] hover:bg-[var(--chat-accent)]/5"
            onClick={(event) => {
              event.stopPropagation()
              onDirectionsClick?.(id)
            }}
          >
            <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
            {directionsLabel}
          </a>
        ) : null}
      </div>
    </article>
  )
}
