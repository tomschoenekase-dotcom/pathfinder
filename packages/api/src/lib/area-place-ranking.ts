import { haversineDistanceMeters } from '@pathfinder/config/geo'

import { explicitlyNamedGuestPlaceLabels, guestPlaceIdentityKey } from './guest-place-identity'

/**
 * Place ranking for area-wide guides (one guide for many separate attractions
 * across an area). Pure and deterministic: callers supply semantic candidates
 * and the visitor position; nothing here reads the database or calls a model.
 */

/** Semantic candidates fetched before the area rerank (the database caps this at 50). */
export const AREA_CANDIDATE_LIMIT = 50
/** Distance at which a place keeps half of its relevance weight. */
export const AREA_DISTANCE_HALF_WEIGHT_METERS = 800
/** Largest multiplier bonus a promoted place can earn from importanceScore. */
export const AREA_MAX_BOOST = 0.2
/** Places this close to an anchor count as part of it. */
export const AREA_ANCHOR_RADIUS_METERS = 150
/**
 * Cosine-distance window around the best semantic match. Candidates inside it
 * compete on distance; weaker matches always follow, so a specific question
 * ("where are the sharks?") is not answered with whatever happens to be nearby.
 * Tune against live area evaluations.
 */
export const AREA_RELEVANCE_WINDOW = 0.1

/** Tags that make a place eligible for the bounded importance boost. */
const BOOSTED_TAGS = new Set(['included', 'partner'])

export type AreaPlaceCandidate = {
  lat: number | null
  lng: number | null
  tags: string[]
  /** pgvector cosine distance from the query (0 = identical). */
  distance?: number
  /** Precomputed visitor distance; recomputed from coordinates when absent. */
  distanceMeters?: number
  /** 0-100 operator weight; only affects places tagged included or partner. */
  importanceScore?: number
}

export type AreaAnchor = {
  id?: string
  name: string
  lat?: number | null
  lng?: number | null
}

type ScoredPlace<T> = {
  place: T
  index: number
  relevance: number
  meters: number | null
  boosted: boolean
  score: number
}

function hasTag(tags: readonly string[], wanted: ReadonlySet<string>): boolean {
  return tags.some((tag) => wanted.has(tag.trim().toLowerCase()))
}

function hasCoordinates(place: {
  lat?: number | null
  lng?: number | null
}): place is { lat: number; lng: number } {
  return (
    typeof place.lat === 'number' &&
    Number.isFinite(place.lat) &&
    typeof place.lng === 'number' &&
    Number.isFinite(place.lng)
  )
}

function scorePlace<T extends AreaPlaceCandidate>(
  place: T,
  index: number,
  userLocation: { lat: number; lng: number },
): ScoredPlace<T> {
  // A candidate without a semantic score is treated as fully relevant, so distance decides.
  const relevance = Math.min(1, Math.max(0, 1 - (place.distance ?? 0)))
  const meters = hasCoordinates(place)
    ? (place.distanceMeters ??
      haversineDistanceMeters(userLocation.lat, userLocation.lng, place.lat, place.lng))
    : null
  const boosted = hasTag(place.tags, BOOSTED_TAGS)
  const importance = Math.min(100, Math.max(0, place.importanceScore ?? 0))
  const boost = boosted ? (importance / 100) * AREA_MAX_BOOST : 0
  const decay = meters === null ? 1 : 0.5 ** (meters / AREA_DISTANCE_HALF_WEIGHT_METERS)
  return { place, index, relevance, meters, boosted, score: relevance * decay * (1 + boost) }
}

/**
 * Honesty guard: a boosted place may never outrank an unboosted place that is
 * at least as relevant and less than a third of its distance away.
 */
function mustPrecede<T>(unboosted: ScoredPlace<T>, boosted: ScoredPlace<T>): boolean {
  return (
    !unboosted.boosted &&
    boosted.boosted &&
    unboosted.meters !== null &&
    boosted.meters !== null &&
    unboosted.relevance >= boosted.relevance &&
    unboosted.meters < boosted.meters / 3
  )
}

function applyGuard<T>(ranked: ScoredPlace<T>[]): ScoredPlace<T>[] {
  const result = [...ranked]
  // The relation only ever moves an unboosted place ahead of a boosted one, so
  // it cannot cycle; each move strictly advances one place.
  let moved = true
  while (moved) {
    moved = false
    for (let i = 1; i < result.length && !moved; i += 1) {
      const candidate = result[i]!
      const blocker = result.findIndex((other, j) => j < i && mustPrecede(candidate, other))
      if (blocker !== -1) {
        result.splice(i, 1)
        result.splice(blocker, 0, candidate)
        moved = true
      }
    }
  }
  return result
}

/**
 * Reranks semantic candidates for an area-wide guide with a live visitor position.
 * Score = relevance x distance decay (half weight every 800 m) x (1 + bounded boost).
 * Strong matches (inside the relevance window) come first, then weaker ones, each
 * ordered by score. Places without coordinates follow, ordered by relevance.
 */
export function rankAreaPlaces<T extends AreaPlaceCandidate>(
  candidates: readonly T[],
  userLocation: { lat: number; lng: number },
  options: { limit: number },
): T[] {
  const scored = candidates.map((place, index) => scorePlace(place, index, userLocation))
  const semanticDistances = candidates
    .map((place) => place.distance)
    .filter((distance): distance is number => typeof distance === 'number')
  const cutoff = semanticDistances.length
    ? Math.min(...semanticDistances) + AREA_RELEVANCE_WINDOW
    : Number.POSITIVE_INFINITY
  const inWindow = (entry: ScoredPlace<T>) => (entry.place.distance ?? 0) <= cutoff
  const byScore = (a: ScoredPlace<T>, b: ScoredPlace<T>) => b.score - a.score || a.index - b.index
  const rankLocated = (entries: ScoredPlace<T>[]) =>
    applyGuard(entries.filter((entry) => entry.meters !== null).sort(byScore))
  const unlocated = scored
    .filter((entry) => entry.meters === null)
    .sort((a, b) => b.relevance - a.relevance || a.index - b.index)
  return [
    ...rankLocated(scored.filter(inWindow)),
    ...rankLocated(scored.filter((entry) => !inWindow(entry))),
    ...unlocated,
  ]
    .slice(0, Math.max(0, Math.floor(options.limit)))
    .map((entry) => entry.place)
}

/**
 * The place a visitor is at: a scanned entry place, otherwise the single
 * supplied place the visitor explicitly named.
 */
export function resolveAreaAnchor<T extends AreaAnchor>(input: {
  query: string
  places: readonly T[]
  entryPlace?: T | null
  identityUnresolved?: boolean
}): T | null {
  if (input.entryPlace) return input.entryPlace
  if (input.identityUnresolved) return null
  const labels = explicitlyNamedGuestPlaceLabels(input.query, input.places)
  if (labels.length !== 1) return null
  const labelKey = guestPlaceIdentityKey(labels[0]!)
  const named = input.places.filter((place) => guestPlaceIdentityKey(place.name) === labelKey)
  return named.length === 1 ? named[0]! : null
}

function sameName(a: string | null | undefined, b: string): boolean {
  return Boolean(a) && a!.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Orders the anchor first, then places inside it (areaName equals the anchor's
 * name) or within 150 m of it, then everything else in the given order.
 */
export function orderPlacesAroundAnchor<
  T extends {
    id?: string
    name: string
    areaName: string | null
    lat: number | null
    lng: number | null
  },
>(places: readonly T[], anchor: AreaAnchor): T[] {
  const isAnchor = (place: T) =>
    anchor.id !== undefined ? place.id === anchor.id : sameName(place.name, anchor.name)
  const isNearAnchor = (place: T) =>
    sameName(place.areaName, anchor.name) ||
    (hasCoordinates(anchor) &&
      hasCoordinates(place) &&
      haversineDistanceMeters(anchor.lat, anchor.lng, place.lat, place.lng) <=
        AREA_ANCHOR_RADIUS_METERS)
  const anchors = places.filter(isAnchor)
  const near = places.filter((place) => !isAnchor(place) && isNearAnchor(place))
  const rest = places.filter((place) => !isAnchor(place) && !isNearAnchor(place))
  return [...anchors, ...near, ...rest]
}

/** Orders knowledge titled for the anchor (for example "Sky Deck - tickets") first. */
export function orderKnowledgeAroundAnchor<T extends { title: string }>(
  entries: readonly T[],
  anchor: AreaAnchor,
): T[] {
  const prefix = anchor.name.trim().toLowerCase()
  if (!prefix) return [...entries]
  const matches = (entry: T) => entry.title.trim().toLowerCase().startsWith(prefix)
  return [...entries.filter(matches), ...entries.filter((entry) => !matches(entry))]
}
