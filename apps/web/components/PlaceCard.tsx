import { useEffect } from 'react'
import { MapPin, Navigation } from 'lucide-react'

type PlaceCardProps = {
  id: string
  name: string
  type: string
  photoUrl: string | null
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
  distanceMeters,
  lat,
  lng,
  onCardClick,
  onDirectionsClick,
  onView,
}: PlaceCardProps) {
  const directionsUrl =
    lat != null && lng != null
      ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
      : null

  useEffect(() => {
    onView?.(id)
  }, [id, onView])

  return (
    <div
      className="overflow-hidden rounded-3xl border border-pf-light bg-pf-white shadow-sm transition hover:border-pf-accent/40 hover:shadow-md"
      onClick={() => {
        onCardClick?.(id)
      }}
    >
      {photoUrl ? (
        <div className="h-36 w-full overflow-hidden bg-pf-surface">
          <img src={photoUrl} alt={name} loading="lazy" className="h-full w-full object-cover" />
        </div>
      ) : (
        <div className="flex h-28 w-full items-center justify-center bg-pf-surface">
          <MapPin className="h-8 w-8 text-pf-light" aria-hidden="true" />
        </div>
      )}

      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-semibold text-pf-deep">{name}</p>
            <p className="mt-0.5 text-xs capitalize text-pf-deep/50">
              {type.toLowerCase().replace(/_/g, ' ')}
            </p>
          </div>
          {distanceMeters !== undefined ? (
            <span className="shrink-0 rounded-full bg-pf-surface px-2.5 py-1 text-xs font-semibold text-pf-primary">
              {formatDistance(distanceMeters)}
            </span>
          ) : null}
        </div>

        {directionsUrl ? (
          <a
            href={directionsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-full border border-pf-light bg-pf-surface px-4 text-xs font-semibold text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
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
    </div>
  )
}
