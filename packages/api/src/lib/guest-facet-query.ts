/** Narrow explicit collection grammar; unsupported filters never become guessed constraints. */
import type { FacetConstraints } from './guest-facet-evidence'

export function parseFacetCollectionQuery(query: string): {
  recognized: boolean
  constraints: FacetConstraints
} {
  const normalized = query.trim().replace(/[\u2010-\u2015]/gu, '-')
  const child = normalized.match(
    /^which rides can my (\d+(?:\.\d+)?)[ -](inch|inches|in|cm)[ -](\d+)[ -]year[ -]old do[?.]?$/iu,
  )
  if (child) {
    const heightCm = Number(child[1]) * (/^(?:inch|inches|in)$/iu.test(child[2]!) ? 2.54 : 1)
    const ageYears = Number(child[3])
    if (Number.isFinite(heightCm) && Number.isFinite(ageYears))
      return { recognized: true, constraints: { kind: 'ride', ageYears, heightCm } }
  }
  // Supported example: "List rides for a 7-year-old who is 46 inches tall lasting at most
  // 20 minutes costing at most USD 8 that are step-free and included in admission."
  // Every optional suffix is explicit and ordered. Any other prose (exceptions, alternatives,
  // preferences, recommendations, translations) makes this lane inactive, not a hard filter.
  const match = normalized.match(
    /^(?:list|which) (rides|exhibits|food|shows)(?: for (?:a |an )?(\d+)[ -]year[ -]old)?(?: who is (\d+(?:\.\d+)?) (inches|cm) tall)?(?: lasting at most (\d+(?:\.\d+)?) minutes)?(?: costing at most (USD|EUR|GBP) (\d+(?:\.\d+)?))?(?: that are (step-free|stairs-only))?(?: and (included|not included) in admission)?(?: with (?:an )?adult present)?[?.]?$/iu,
  )
  if (!match) {
    // Explicit list intent can safely request the whole unknown union without inventing filters.
    // Recommendations/location questions retain their separate ranking and cards.
    if (
      /^(?:which|list|show me all) (?:rides|exhibits|food|shows)(?: [^?!\n]*)?[?.]?$/iu.test(
        normalized,
      ) &&
      !/\b(?:recommend|best|closest|nearest|near me|should|prefer)\b/iu.test(normalized)
    )
      return { recognized: true, constraints: {} }
    return { recognized: false, constraints: {} }
  }
  const kind = ({ rides: 'ride', exhibits: 'exhibit', food: 'food', shows: 'show' } as const)[
    match[1]!.toLowerCase() as 'rides' | 'exhibits' | 'food' | 'shows'
  ]
  const constraints: FacetConstraints = { kind }
  if (match[2]) constraints.ageYears = Number(match[2])
  if (match[3])
    constraints.heightCm = Number(match[3]) * (match[4]!.toLowerCase() === 'inches' ? 2.54 : 1)
  if (match[5]) constraints.maxDurationMinutes = Number(match[5])
  if (match[6] && match[7])
    constraints.maxPrice = {
      amount: Number(match[7]),
      currency: match[6].toUpperCase() as 'USD' | 'EUR' | 'GBP',
    }
  if (match[8]) constraints.access = match[8].toLowerCase() as 'step-free' | 'stairs-only'
  if (match[9]) constraints.included = match[9].toLowerCase() === 'included'
  if (/\bwith (?:an )?adult present[?.]?$/iu.test(query.trim())) constraints.adultPresent = true
  if (
    [
      constraints.ageYears,
      constraints.heightCm,
      constraints.maxDurationMinutes,
      constraints.maxPrice?.amount,
    ].some((value) => value !== undefined && !Number.isFinite(value))
  )
    return { recognized: false, constraints: {} }
  return { recognized: true, constraints }
}
