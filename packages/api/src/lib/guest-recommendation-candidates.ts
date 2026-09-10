import {
  GuestVisitContextInput,
  type GuestVisitContextInput as GuestVisitContext,
} from '@pathfinder/contracts/guest-visit-context'

import { guestPlaceIdentityKey } from './guest-place-identity'

import { isGuestRecommendationQuery } from './guest-visit-retrieval-query'

type AuthorizedPlace = {
  id?: string
  name: string
  areaName?: string | null
}

/**
 * Applies visit preferences only after a caller has scoped and authorized place
 * candidates. It never resolves visitor-provided IDs or changes factual paths.
 */
export function partitionGuestRecommendationPlaces<T extends AuthorizedPlace>(input: {
  query: string
  visitContext?: GuestVisitContext | undefined
  places: readonly T[]
  identityUnresolved?: boolean
}): {
  places: T[]
  authorizedVisitPlaces: T[]
  recommendationOnly: boolean
  excludedVisitedCount: number
} {
  const authorizedVisitPlaces = [...input.places]
  const visitContext = input.visitContext ? GuestVisitContextInput.parse(input.visitContext) : null
  // Asking whether a specific supplied place is worth visiting is itself a reason
  // to discuss it, even when it was already visited. Comparisons such as 'more
  // like Train Hall' still request new options and do not match this direct form.
  const directRecommendationTarget = input.query.match(
    /\b(?:would|do|can|could)\s+you\s+recommend\s+(?:(?:visiting|seeing)\s+)?(?:the\s+)?(.+)$/iu,
  )?.[1]
  const directTargetKey = directRecommendationTarget
    ? guestPlaceIdentityKey(directRecommendationTarget)
    : ''
  const explicitlyRequestedPlace =
    Boolean(directTargetKey) &&
    authorizedVisitPlaces.some(({ name }) => {
      const nameKey = guestPlaceIdentityKey(name)
      return (
        Boolean(nameKey) &&
        (directTargetKey === nameKey || directTargetKey.startsWith(`${nameKey} `))
      )
    })
  const recommendationOnly =
    !input.identityUnresolved &&
    !explicitlyRequestedPlace &&
    isGuestRecommendationQuery(input.query)

  if (!recommendationOnly || !visitContext?.visitedPlaceIds.length) {
    return {
      places: authorizedVisitPlaces,
      authorizedVisitPlaces,
      recommendationOnly,
      excludedVisitedCount: 0,
    }
  }

  const visitedIds = new Set(visitContext.visitedPlaceIds)
  const places = authorizedVisitPlaces.filter((place) => !place.id || !visitedIds.has(place.id))
  return {
    places,
    authorizedVisitPlaces,
    recommendationOnly,
    excludedVisitedCount: authorizedVisitPlaces.length - places.length,
  }
}

/** Reserves a bounded over-fetch only for recommendation filtering. */
export function guestRecommendationRetrievalLimit(
  query: string,
  visitContext: GuestVisitContext | undefined,
  baseLimit: number,
): number {
  if (!Number.isSafeInteger(baseLimit) || baseLimit < 0)
    throw new RangeError('Recommendation retrieval base limit must be a non-negative safe integer')
  if (!isGuestRecommendationQuery(query) || !visitContext) return baseLimit

  const parsed = GuestVisitContextInput.parse(visitContext)
  return baseLimit + Math.min(20, new Set(parsed.visitedPlaceIds).size)
}
