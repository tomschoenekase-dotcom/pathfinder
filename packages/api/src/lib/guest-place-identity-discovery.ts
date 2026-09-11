import type { SemanticPlace } from '@pathfinder/db'
import type { Prisma } from '@prisma/client'

import {
  compatibleGuestPlaceIdentityCandidates,
  explicitlyNamedGuestPlaceLabels,
  guestPlaceIdentityKey,
  isExplicitGuestPlaceNonIdentityRequest,
  type GuestPlaceIdentityProjection,
} from './guest-place-identity'

const MAX_IDENTITY_SEED_LABELS = 8
const MAX_EXACT_LABEL_CANDIDATES = 65
const MAX_IDENTITY_CONTEXT_CANDIDATES =
  MAX_IDENTITY_SEED_LABELS * MAX_EXACT_LABEL_CANDIDATES + MAX_IDENTITY_SEED_LABELS

export type GuestPlaceIdentityDiscoveryReader = {
  place: { findMany(args: Prisma.PlaceFindManyArgs): Promise<SemanticPlace[]> }
}

export async function expandExplicitGuestPlaceIdentityCandidates(input: {
  reader: GuestPlaceIdentityDiscoveryReader
  query: string
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  places: SemanticPlace[]
  explicitLabels?: ReadonlyArray<string>
}): Promise<{ places: SemanticPlace[]; saturatedLabelKeys: Set<string> }> {
  const labels = [
    ...new Map(
      [
        ...(input.explicitLabels ?? []),
        ...explicitlyNamedGuestPlaceLabels(input.query, input.places),
      ]
        .map((label) => label.trim())
        .filter(Boolean)
        .map((label) => [guestPlaceIdentityKey(label), label]),
    ).values(),
  ].slice(0, MAX_IDENTITY_SEED_LABELS)
  const rowsByLabel = await Promise.all(
    labels.map((name) =>
      input.reader.place.findMany({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          isActive: true,
          visibility: input.includeSecondLayer ? { in: ['PUBLIC', 'SECOND_LAYER'] } : 'PUBLIC',
          name: { equals: name, mode: 'insensitive' },
        },
        orderBy: [{ importanceScore: 'desc' }, { id: 'asc' }],
        take: MAX_EXACT_LABEL_CANDIDATES,
        select: {
          id: true,
          name: true,
          type: true,
          itemType: true,
          shortDescription: true,
          longDescription: true,
          lat: true,
          lng: true,
          tags: true,
          areaName: true,
          hours: true,
          photoUrl: true,
          sourceType: true,
          sourceName: true,
          sourceUrl: true,
        },
      }),
    ),
  )
  const saturatedLabelKeys = new Set(
    rowsByLabel.flatMap((rows, index) =>
      rows.length === MAX_EXACT_LABEL_CANDIDATES ? [guestPlaceIdentityKey(labels[index]!)] : [],
    ),
  )
  const merged = new Map(rowsByLabel.flat().map((place) => [place.id, place as SemanticPlace]))
  for (const seed of input.places) {
    const expanded = merged.get(seed.id)
    // The exact second read supplies current canonical fields, while properties
    // it does not select (such as semantic or physical distance) remain caller-owned.
    merged.set(seed.id, expanded ? { ...seed, ...expanded } : seed)
  }
  const places = [...merged.values()]
  return { places, saturatedLabelKeys }
}

export function hasIncompleteGuestPlaceIdentityDiscovery(input: {
  query: string
  places: ReadonlyArray<{ name: string }>
  saturatedLabelKeys: ReadonlySet<string>
}): boolean {
  return (
    !isExplicitGuestPlaceNonIdentityRequest(input.query) &&
    input.places.some((place) => input.saturatedLabelKeys.has(guestPlaceIdentityKey(place.name)))
  )
}

export function selectGuestPlaceIdentityContext(input: {
  query: string
  places: SemanticPlace[]
  identity: GuestPlaceIdentityProjection
  limit?: number
}): SemanticPlace[] {
  const limit = Math.max(1, Math.min(MAX_IDENTITY_CONTEXT_CANDIDATES, Math.floor(input.limit ?? 8)))
  if (isExplicitGuestPlaceNonIdentityRequest(input.query)) return input.places.slice(0, limit)

  const namedLabelKeys = new Set(
    explicitlyNamedGuestPlaceLabels(input.query, input.identity.places).map(guestPlaceIdentityKey),
  )
  if (!namedLabelKeys.size) return input.places.slice(0, limit)

  const namedCandidates = input.identity.places.filter((candidate) =>
    namedLabelKeys.has(guestPlaceIdentityKey(candidate.name)),
  )
  const compatible = compatibleGuestPlaceIdentityCandidates({
    query: input.query,
    candidates: namedCandidates,
  })
  const placeById = new Map(input.places.map((place) => [place.id, place]))
  const compatibleIds = new Set(compatible.map((candidate) => candidate.id))
  const prioritized = [
    ...compatible.map((candidate) => placeById.get(candidate.id)).filter(Boolean),
    ...input.places.filter(
      (place) =>
        compatibleIds.has(place.id) || !namedLabelKeys.has(guestPlaceIdentityKey(place.name)),
    ),
  ] as SemanticPlace[]
  return [...new Map(prioritized.map((place) => [place.id, place])).values()].slice(0, limit)
}
