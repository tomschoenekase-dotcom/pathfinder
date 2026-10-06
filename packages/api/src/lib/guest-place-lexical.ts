import type { SemanticPlace } from '@pathfinder/db'

import { haversineDistanceMeters } from './geo'
import {
  containsGuestTerm,
  guestRetrievalConcepts,
  normalizeGuestText,
} from './guest-knowledge-retrieval'

const LEXICAL_PLACE_CANDIDATES = 40
const BROAD_PLACE_LIMIT = 12
const FUSION_RANK_OFFSET = 10
// The nearest semantic places always stay, as with Knowledge, so fusion only adds recall.
const GUARANTEED_SEMANTIC_PLACES = 5

type GuestPlaceRow = Omit<SemanticPlace, 'distance' | 'distanceMeters'>

export type GuestPlaceLexicalReader = {
  place: { findMany(args: Record<string, unknown>): Promise<GuestPlaceRow[]> }
}

function placeScore(place: GuestPlaceRow, concepts: string[][]): number {
  const name = normalizeGuestText(place.name)
  const kind = normalizeGuestText(`${place.type} ${place.itemType ?? ''}`)
  const detail = normalizeGuestText(
    [place.shortDescription, place.longDescription, place.areaName, ...place.tags]
      .filter(Boolean)
      .join(' '),
  )
  let score = 0
  for (const concept of concepts) {
    if (concept.some((term) => containsGuestTerm(name, term))) score += 8
    else if (concept.some((term) => containsGuestTerm(kind, term))) score += 5
    else if (concept.some((term) => containsGuestTerm(detail, term))) score += 2
  }
  return score
}

/**
 * Adds text-matched places to the semantic place list. Places without a stored embedding are
 * otherwise invisible whenever a query embedding exists, which hid freshly imported restaurants
 * and rides. Both lanes are fused by rank; the caller's scope (tenant, venue, visibility) is
 * applied here exactly as in the semantic query.
 */
export async function fuseGuestPlacesWithLexical(params: {
  reader: unknown
  query: string
  previousQuery?: string | null
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  /** May be pending: the lexical read runs in parallel with the semantic search. */
  semanticPlaces: SemanticPlace[] | Promise<SemanticPlace[]>
  limit: number
  userLat: number | null
  userLng: number | null
}): Promise<SemanticPlace[]> {
  const { concepts, broad } = guestRetrievalConcepts(params.query, params.previousQuery)
  const limit = broad ? Math.max(params.limit, BROAD_PLACE_LIMIT) : params.limit
  const reader = params.reader as Partial<GuestPlaceLexicalReader>
  if (concepts.length === 0 || typeof reader.place?.findMany !== 'function')
    return (await params.semanticPlaces).slice(0, limit)
  const terms = [...new Set(concepts.flat())]
  // Lexical recall is additive: any read failure keeps the semantic result unchanged.
  const rowsPromise = Promise.resolve()
    .then(() =>
      reader.place!.findMany({
        where: {
          tenantId: params.tenantId,
          venueId: params.venueId,
          isActive: true,
          ...(params.includeSecondLayer ? {} : { visibility: 'PUBLIC' }),
          OR: terms.flatMap((term) => [
            { name: { contains: term, mode: 'insensitive' } },
            { type: { contains: term, mode: 'insensitive' } },
            { itemType: { contains: term, mode: 'insensitive' } },
            { shortDescription: { contains: term, mode: 'insensitive' } },
            { longDescription: { contains: term, mode: 'insensitive' } },
            { areaName: { contains: term, mode: 'insensitive' } },
            { tags: { has: term } },
          ]),
        },
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
        orderBy: [{ importanceScore: 'desc' }, { id: 'asc' }],
        take: LEXICAL_PLACE_CANDIDATES,
      }),
    )
    .then((result) => (Array.isArray(result) ? result : []))
    .catch(() => [] as GuestPlaceRow[])
  const [semanticPlaces, rows] = await Promise.all([params.semanticPlaces, rowsPromise])
  const lexical = rows
    .map((place) => ({ place, score: placeScore(place, concepts) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
  const fused = new Map<string, { place: SemanticPlace; score: number; order: number }>()
  semanticPlaces.forEach((place, index) => {
    fused.set(place.id, { place, score: 1 / (FUSION_RANK_OFFSET + index + 1), order: index })
  })
  lexical.forEach(({ place }, index) => {
    const contribution = 1 / (FUSION_RANK_OFFSET + index + 1)
    const existing = fused.get(place.id)
    if (existing) {
      existing.score += contribution
      return
    }
    fused.set(place.id, {
      place: {
        ...place,
        ...(place.lat != null &&
        place.lng != null &&
        params.userLat != null &&
        params.userLng != null
          ? {
              distanceMeters: haversineDistanceMeters(
                params.userLat,
                params.userLng,
                place.lat,
                place.lng,
              ),
            }
          : {}),
      },
      score: contribution,
      order: fused.size,
    })
  })
  const ranked = [...fused.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ place }) => place)
  const guaranteed = new Set(
    semanticPlaces.slice(0, GUARANTEED_SEMANTIC_PLACES).map((place) => place.id),
  )
  const selected = ranked.slice(0, limit)
  for (const place of ranked.slice(limit)) {
    if (!guaranteed.has(place.id)) continue
    let replaceAt = selected.length - 1
    while (replaceAt >= 0 && guaranteed.has(selected[replaceAt]!.id)) replaceAt -= 1
    if (replaceAt < 0) break
    selected.splice(replaceAt, 1)
    selected.push(place)
  }
  return selected
}
