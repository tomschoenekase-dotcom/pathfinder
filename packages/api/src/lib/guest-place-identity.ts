import type { db } from '@pathfinder/db'

type RetrievedPlace = { id: string; name: string; areaName: string | null }
export type GuestPlaceIdentityLocationRow = {
  primaryPlaceId: string | null
  displayName: string
  floor: { name: string; stableKey: string; tenantId: string; venueId: string } | null
}
export type GuestPlaceIdentityReader = Pick<typeof db, 'venueLocation'>
type GuestPlaceIdentityCandidate = RetrievedPlace & {
  location: string | null
  floor: string | null
}

export type GuestPlaceIdentityProjection = {
  places: GuestPlaceIdentityCandidate[]
  ambiguity: { requestedName: string; candidates: GuestPlaceIdentityCandidate[] } | null
}

export function guestPlaceIdentityKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function includesPhrase(query: string, phrase: string): boolean {
  return phrase.length >= 3 && ` ${query} `.includes(` ${phrase} `)
}

export function isExplicitGuestPlaceNonIdentityRequest(query: string): boolean {
  query = guestPlaceIdentityKey(query)
  return ['compare', 'recommend', 'should i see', 'see next', 'what else', 'list'].some((phrase) =>
    includesPhrase(query, phrase),
  )
}

export function explicitlyNamedGuestPlaceLabels(
  query: string,
  places: ReadonlyArray<{ name: string }>,
): string[] {
  const normalizedQuery = guestPlaceIdentityKey(query)
  const labels = new Map<string, string>()
  for (const place of places) {
    const key = guestPlaceIdentityKey(place.name)
    if (key && includesPhrase(normalizedQuery, key) && !labels.has(key)) labels.set(key, place.name)
  }
  return [...labels.values()]
}

/** Enriches only already-authorized candidates; it never discovers venue-wide labels. */
export async function projectGuestPlaceIdentity(params: {
  reader?: GuestPlaceIdentityReader
  query: string
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  places: RetrievedPlace[]
}): Promise<GuestPlaceIdentityProjection> {
  const query = guestPlaceIdentityKey(params.query)
  const grouped = new Map<string, RetrievedPlace[]>()
  for (const place of params.places) {
    const label = guestPlaceIdentityKey(place.name)
    if (!label || !includesPhrase(query, label)) continue
    grouped.set(label, [...(grouped.get(label) ?? []), place])
  }
  const duplicate = [...grouped.entries()].find(([, places]) => places.length > 1)
  if (!duplicate)
    return {
      places: params.places.map((place) => ({
        ...place,
        location: null,
        floor: null,
      })),
      ambiguity: null,
    }

  const candidateIds = duplicate[1].map((place) => place.id)
  const locations: GuestPlaceIdentityLocationRow[] = params.reader
    ? await params.reader.venueLocation.findMany({
        where: {
          tenantId: params.tenantId,
          venueId: params.venueId,
          isActive: true,
          visibility: params.includeSecondLayer ? { in: ['PUBLIC', 'SECOND_LAYER'] } : 'PUBLIC',
          primaryPlaceId: { in: candidateIds },
          OR: [
            { floorId: null },
            {
              floor: { is: { tenantId: params.tenantId, venueId: params.venueId, isActive: true } },
            },
          ],
        },
        select: {
          primaryPlaceId: true,
          displayName: true,
          floor: { select: { name: true, stableKey: true, tenantId: true, venueId: true } },
        },
      })
    : []
  const locationsByPlace = new Map<string, (typeof locations)[number][]>()
  for (const location of locations) {
    if (!location.primaryPlaceId) continue
    locationsByPlace.set(location.primaryPlaceId, [
      ...(locationsByPlace.get(location.primaryPlaceId) ?? []),
      location,
    ])
  }
  const candidates = duplicate[1].map((place) => {
    const matches = locationsByPlace.get(place.id) ?? []
    const location = matches.length === 1 ? matches[0] : null
    return {
      ...place,
      location: location?.displayName ?? place.areaName,
      floor: location?.floor?.name ?? null,
    }
  })
  const floorMatched = candidates.filter((candidate) =>
    candidate.floor ? includesPhrase(query, guestPlaceIdentityKey(candidate.floor)) : false,
  )
  // Missing location data cannot rule out another exhibit on the requested
  // floor. Narrow only candidates with a known, contradictory floor.
  const compatibleCandidates =
    floorMatched.length > 0
      ? candidates.filter(
          (candidate) => candidate.floor === null || floorMatched.includes(candidate),
        )
      : candidates
  const isAmbiguous =
    !isExplicitGuestPlaceNonIdentityRequest(query) && compatibleCandidates.length > 1
  const ambiguity = isAmbiguous
    ? {
        requestedName: duplicate[1][0]!.name,
        candidates: compatibleCandidates,
      }
    : null
  return { places: candidates, ambiguity }
}
