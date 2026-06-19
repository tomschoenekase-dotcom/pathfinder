import { haversineDistanceMeters } from '@pathfinder/config/geo'

export { haversineDistanceMeters }

type PlaceWithCoords = {
  id: string
  lat: number | null | undefined
  lng: number | null | undefined
  [key: string]: unknown
}
type PlaceWithDistance<T extends PlaceWithCoords> = T & {
  lat: number
  lng: number
  distanceMeters: number
}

/**
 * Returns the `limit` nearest places to the given coordinates, sorted by
 * ascending distance. Each result has `distanceMeters` attached.
 */
export function findNearestPlaces<T extends PlaceWithCoords>(
  userLat: number,
  userLng: number,
  places: T[],
  limit: number,
): PlaceWithDistance<T>[] {
  return places
    .filter(
      (place): place is T & { lat: number; lng: number } => place.lat != null && place.lng != null,
    )
    .map((place) => ({
      ...place,
      distanceMeters: haversineDistanceMeters(userLat, userLng, place.lat, place.lng),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit)
}
