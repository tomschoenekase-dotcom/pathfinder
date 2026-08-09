const CARD_LIMIT = 3
const NAME_LIMIT = 200
const TYPE_LIMIT = 100
const DESCRIPTION_LIMIT = 500
const AREA_LIMIT = 200
const HOURS_LIMIT = 200

type GuestPlaceCardCandidate = {
  id: string
  name: string
  type: string
  shortDescription?: string | null
  areaName?: string | null
  hours?: string | null
  photoUrl?: string | null
  lat?: number | null
  lng?: number | null
  distanceMeters?: number | undefined
}

export type GuestPlaceCard = {
  id: string
  name: string
  type: string
  shortDescription: string | null
  areaName: string | null
  hours: string | null
  photoUrl: string | null
  distanceMeters: number | undefined
  lat: number | null
  lng: number | null
}

function boundedText(value: string | null | undefined, limit: number): string | null {
  const normalized = value?.trim().normalize('NFC')
  return normalized ? Array.from(normalized).slice(0, limit).join('') : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type MentionSpan = { start: number; end: number }

function findMentionSpans(response: string, name: string): MentionSpan[] {
  const normalizedName = name.trim().normalize('NFC')
  if (!normalizedName) return []

  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}])${escapeRegExp(normalizedName)}(?![\\p{L}\\p{N}\\p{M}])`,
    'giu',
  )
  return Array.from(response.matchAll(pattern), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function hasValidCoordinatePair(
  lat: number | null | undefined,
  lng: number | null | undefined,
): lat is number {
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lng === 'number' &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  )
}

function safePhotoUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 2_000) return null

  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null
  } catch {
    return null
  }
}

export function buildGuestPlaceCards({
  assistantResponse,
  hasLiveLocation,
  places,
}: {
  assistantResponse: string
  hasLiveLocation: boolean
  places: GuestPlaceCardCandidate[]
}): GuestPlaceCard[] {
  const normalizedResponse = assistantResponse.normalize('NFC')
  const candidates = places.map((place) => ({
    place,
    spans: findMentionSpans(normalizedResponse, place.name),
  }))

  return candidates
    .filter(({ spans }, candidateIndex) =>
      spans.some(
        (span) =>
          !candidates.some(
            ({ spans: otherSpans }, otherIndex) =>
              otherIndex !== candidateIndex &&
              otherSpans.some(
                (other) =>
                  other.start <= span.start &&
                  other.end >= span.end &&
                  other.end - other.start > span.end - span.start,
              ),
          ),
      ),
    )
    .slice(0, CARD_LIMIT)
    .map(({ place }) => {
      const hasCoordinates = hasLiveLocation && hasValidCoordinatePair(place.lat, place.lng)
      const distanceMeters =
        hasCoordinates &&
        typeof place.distanceMeters === 'number' &&
        Number.isFinite(place.distanceMeters) &&
        place.distanceMeters >= 0
          ? place.distanceMeters
          : undefined

      return {
        id: place.id,
        name: boundedText(place.name, NAME_LIMIT) ?? 'Guide item',
        type: boundedText(place.type, TYPE_LIMIT) ?? 'PLACE',
        shortDescription: boundedText(place.shortDescription, DESCRIPTION_LIMIT),
        areaName: boundedText(place.areaName, AREA_LIMIT),
        hours: boundedText(place.hours, HOURS_LIMIT),
        photoUrl: hasLiveLocation ? safePhotoUrl(place.photoUrl) : null,
        distanceMeters,
        lat: hasCoordinates ? place.lat! : null,
        lng: hasCoordinates ? place.lng! : null,
      }
    })
}
