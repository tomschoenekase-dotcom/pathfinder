import type { db } from '@pathfinder/db'

type RetrievedPlace = { id: string; name: string; areaName: string | null }
export type GuestPlaceIdentityLocationRow = {
  primaryPlaceId: string | null
  displayName: string
  floor: { name: string; stableKey: string; tenantId: string; venueId: string } | null
}
export type GuestPlaceIdentityReader = Pick<typeof db, 'venueLocation'>
export type GuestPlaceIdentityCandidate = RetrievedPlace & {
  location: string | null
  floor: string | null
}

export type GuestPlaceIdentityProjection = {
  places: GuestPlaceIdentityCandidate[]
  ambiguity: {
    requestedName: string
    candidates: GuestPlaceIdentityCandidate[]
    conflictingClues?: true
  } | null
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

function trimmedIdentityLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
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

export function compatibleGuestPlaceIdentityCandidates(input: {
  query: string
  candidates: GuestPlaceIdentityCandidate[]
}): GuestPlaceIdentityCandidate[] {
  const query = guestPlaceIdentityKey(input.query)
  const floorConstraint = input.candidates.some((candidate) =>
    includesPhrase(query, guestPlaceIdentityKey(candidate.floor ?? '')),
  )
  const locationConstraint = input.candidates.some((candidate) =>
    includesPhrase(query, guestPlaceIdentityKey(candidate.location ?? '')),
  )
  const compatible = (value: string | null, constraint: boolean) => {
    const key = guestPlaceIdentityKey(value ?? '')
    return !constraint || !key || includesPhrase(query, key)
  }
  return input.candidates.filter(
    (candidate) =>
      compatible(candidate.floor, floorConstraint) &&
      compatible(candidate.location, locationConstraint),
  )
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
      location: trimmedIdentityLabel(location?.displayName) ?? trimmedIdentityLabel(place.areaName),
      floor: trimmedIdentityLabel(location?.floor?.name),
    }
  })
  const compatibleCandidates = compatibleGuestPlaceIdentityCandidates({ query, candidates })
  const identityRequest = !isExplicitGuestPlaceNonIdentityRequest(query)
  const ambiguity =
    identityRequest && compatibleCandidates.length !== 1
      ? {
          requestedName: duplicate[1][0]!.name,
          candidates: compatibleCandidates,
          ...(compatibleCandidates.length === 0 ? { conflictingClues: true as const } : {}),
        }
      : null
  return { places: candidates, ambiguity }
}
