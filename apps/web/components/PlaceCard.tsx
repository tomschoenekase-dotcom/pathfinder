import { useEffect } from 'react'

type PlaceCardProps = {
  id: string
  name: string
  type: string
  photoUrl: string | null
  distanceMeters: number
  lat: number
  lng: number
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
  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`

  useEffect(() => {
    onView?.(id)
  }, [id, onView])

  return (
    <div
      className="flex items-center gap-3 overflow-hidden rounded-2xl border border-white/10 bg-white/8 shadow-lg"
      onClick={() => {
        onCardClick?.(id)
      }}
    >
      {photoUrl ? (
        <img src={photoUrl} alt={name} loading="lazy" className="h-16 w-16 shrink-0 object-cover" />
      ) : (
        <div className="flex h-16 w-16 shrink-0 items-center justify-center bg-slate-800 text-2xl">
          📍
        </div>
      )}
      <div className="min-w-0 flex-1 py-2 pr-3">
        <p className="truncate text-sm font-semibold text-white">{name}</p>
        <p className="text-xs text-slate-400 capitalize">{type.toLowerCase().replace(/_/g, ' ')}</p>
        <p className="text-xs text-cyan-300">{formatDistance(distanceMeters)}</p>
      </div>
      <a
        href={directionsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mr-3 shrink-0 rounded-full border border-cyan-400/40 px-3 py-1.5 text-xs font-medium text-cyan-300 transition hover:border-cyan-300 hover:bg-cyan-400/10"
        onClick={(event) => {
          event.stopPropagation()
          onDirectionsClick?.(id)
        }}
      >
        Directions
      </a>
    </div>
  )
}
