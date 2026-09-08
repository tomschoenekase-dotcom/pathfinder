import type { db } from '@pathfinder/db'

type RetrievedPlace = { id: string; name: string; areaName: string | null }
type GuestPlaceIdentityReader = Pick<typeof db, 'venueLocation'>
type GuestPlaceIdentityCandidate = RetrievedPlace & {
  location: string | null
  floor: string | null
}

export type GuestPlaceIdentityProjection = {
  places: GuestPlaceIdentityCandidate[]
  ambiguity: { requestedName: string; candidates: GuestPlaceIdentityCandidate[] } | null
}

function normalized(value: string): string {
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

function isExplicitNonIdentityRequest(query: string): boolean {
  return ['compare', 'recommend', 'should i see', 'see next', 'what else', 'list'].some((phrase) =>
    includesPhrase(query, phrase),
  )
}

/** Enriches only already-authorized candidates; it never discovers venue-wide labels. */
export async function projectGuestPlaceIdentity(params: {
  reader: GuestPlaceIdentityReader
  query: string
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  places: RetrievedPlace[]
}): Promise<GuestPlaceIdentityProjection> {
  const query = normalized(params.query)
  const grouped = new Map<string, RetrievedPlace[]>()
  for (const place of params.places) {
    const label = normalized(place.name)
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
  const locations = await params.reader.venueLocation.findMany({
    where: {
      tenantId: params.tenantId,
      venueId: params.venueId,
      isActive: true,
      visibility: params.includeSecondLayer ? { in: ['PUBLIC', 'SECOND_LAYER'] } : 'PUBLIC',
      primaryPlaceId: { in: candidateIds },
      OR: [
        { floorId: null },
        { floor: { is: { tenantId: params.tenantId, venueId: params.venueId, isActive: true } } },
      ],
    },
    select: {
      primaryPlaceId: true,
      displayName: true,
      floor: { select: { name: true, stableKey: true, tenantId: true, venueId: true } },
    },
  })
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
    candidate.floor ? includesPhrase(query, normalized(candidate.floor)) : false,
  )
  const isAmbiguous =
    !isExplicitNonIdentityRequest(query) &&
    (floorMatched.length === 0 ? candidates.length > 1 : floorMatched.length > 1)
  const ambiguity = isAmbiguous
    ? {
        requestedName: duplicate[1][0]!.name,
        candidates: floorMatched.length > 1 ? floorMatched : candidates,
      }
    : null
  return { places: candidates, ambiguity }
}
