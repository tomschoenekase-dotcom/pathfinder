import type { GuestVisitContextInput } from '@pathfinder/contracts/guest-visit-context'

const MAX_RETRIEVAL_QUERY_CHARS = 1_500

const RECOMMENDATION_INTENT =
  /\b(?:what\s+(?:else\s+)?should\s+i\s+(?:see|do)|what\s+should\s+i\s+see\s+next|where\s+should\s+i\s+go\s+next|what\s+can\s+i\s+see\s+next|what\s+do\s+you\s+recommend|recommend(?:ation|ations)?|suggest(?:ion|ions)?|more\s+like\s+\S+|something\s+(?:else|similar))\b/iu

const DIRECT_EXHIBIT_IDENTITY =
  /\b(?:case|exhibit|display|artifact|object)\s*(?:#|no\.?\s*)?\d+\b/iu

const SAFETY_OR_POLICY =
  /\b(?:safety|safe|emergency|fire|exit|exits|injury|injured|hurt|ill|allergy|allergies|closed|closure|hours|evacuat(?:e|ion)|security|policy|policies|rules?|allowed|prohibited|permit(?:ted)?|accessibility|accessible)\b/iu

const EXPLICIT_REVISIT_OR_DETAIL =
  /\b(?:again|revisit|back\s+to|return\s+to|tell\s+me\s+more\s+about|explain|describe)\b/iu

/**
 * Narrow English-only recommendation intent. Detail, revisit, safety, and direct
 * exhibit questions retain their full authorized grounding candidates.
 */
export function isGuestRecommendationQuery(query: string): boolean {
  return (
    RECOMMENDATION_INTENT.test(query) &&
    !DIRECT_EXHIBIT_IDENTITY.test(query) &&
    !SAFETY_OR_POLICY.test(query) &&
    !EXPLICIT_REVISIT_OR_DETAIL.test(query)
  )
}

/**
 * Prioritizes explicit interests before broad English recommendation wording so the
 * existing bounded lexical concept reader does not discard them after generic question words. This deliberately
 * excludes visit IDs and remaining time: neither is a venue search term or a retrieved fact.
 */
export function guestVisitRetrievalQuery(
  query: string,
  visitContext?: GuestVisitContextInput,
): string {
  const interests = (visitContext?.interests ?? [])
    .map((interest) => interest.trim())
    .filter(Boolean)
  if (!interests.length || !isGuestRecommendationQuery(query)) {
    return query
  }

  const remaining = MAX_RETRIEVAL_QUERY_CHARS - query.length - 1
  if (remaining <= 0) return query

  const boundedInterests: string[] = []
  let used = 0
  for (const interest of interests) {
    const separator = boundedInterests.length ? '; ' : ''
    if (used + separator.length + interest.length > remaining) break
    boundedInterests.push(interest)
    used += separator.length + interest.length
  }
  return boundedInterests.length ? `${boundedInterests.join('; ')}\n${query}` : query
}
