import { useEffect, useId, useState } from 'react'
import { Info, MapPin, Navigation } from 'lucide-react'

type PlaceCardProps = {
  id: string
  name: string
  type: string
  photoUrl: string | null
  shortDescription: string | null
  areaName: string | null
  hours: string | null
  distanceMeters: number | undefined
  lat: number | null
  lng: number | null
  onCardClick?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
  onView?: (placeId: string) => void
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
  shortDescription,
  areaName,
  hours,
  distanceMeters,
  lat,
  lng,
  onCardClick,
  onDirectionsClick,
  onView,
}: PlaceCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
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

  return (
    <article
      aria-labelledby={titleId}
      className="overflow-hidden rounded-3xl border border-[var(--chat-border)] bg-[var(--chat-card)] shadow-sm transition hover:border-[var(--chat-accent)]/40 hover:shadow-md"
    >
      {photoUrl ? (
        <div className="h-36 w-full overflow-hidden bg-[var(--chat-bg)]">
          {/* Deliberately bypass Next's optimizer: live-location cards admit bounded arbitrary HTTPS
              venue URLs, and proxying those through the server would widen the remote-fetch boundary. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl}
            alt={name}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        </div>
      ) : (
        <div className="flex h-28 w-full items-center justify-center bg-[var(--chat-bg)]">
          {hasCoordinates ? (
            <MapPin className="h-8 w-8 text-[var(--chat-border)]" aria-hidden="true" />
          ) : (
            <Info className="h-8 w-8 text-[var(--chat-border)]" aria-hidden="true" />
          )}
        </div>
      )}

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
            {isExpanded ? `Hide details for ${name}` : `Show details for ${name}`}
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
                <span className="font-semibold text-[var(--chat-text)]">Area:</span> {areaName}
              </p>
            ) : null}
            {hours ? (
              <p>
                <span className="font-semibold text-[var(--chat-text)]">Hours:</span> {hours}
              </p>
            ) : null}
          </div>
        ) : null}

        {directionsUrl ? (
          <a
            href={directionsUrl}
            aria-label={`Get directions to ${name}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-full border border-[var(--chat-border)] bg-[var(--chat-bg)] px-4 text-xs font-semibold text-[var(--chat-accent-text)] transition hover:border-[var(--chat-accent)] hover:bg-[var(--chat-accent)]/5"
            onClick={(event) => {
              event.stopPropagation()
              onDirectionsClick?.(id)
            }}
          >
            <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
            Get directions
          </a>
        ) : null}
      </div>
    </article>
  )
}
