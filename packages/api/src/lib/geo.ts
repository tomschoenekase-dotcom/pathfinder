const EARTH_RADIUS_METERS = 6_371_000

/**
 * Haversine formula — returns the great-circle distance in meters between two
 * coordinates. Accurate enough for venue-scale distances (sub-kilometre).
 */
export function haversineDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180

  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return EARTH_RADIUS_METERS * c
}

type PlaceWithCoords = { id: string; lat: number; lng: number; [key: string]: unknown }
type PlaceWithDistance<T extends PlaceWithCoords> = T & { distanceMeters: number }

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
    .map((place) => ({
      ...place,
      distanceMeters: haversineDistanceMeters(userLat, userLng, place.lat, place.lng),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit)
}
