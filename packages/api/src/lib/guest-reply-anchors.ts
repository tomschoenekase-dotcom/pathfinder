import { normalizeGuestText } from './guest-knowledge-retrieval'

// Words that never identify one place on their own, however rare they are in a venue's names.
const NAME_STOP_WORDS = new Set([
  'the',
  'and',
  'of',
  'a',
  'an',
  'at',
  'in',
  'on',
  'to',
  'for',
  'from',
  'with',
  'by',
  's',
])
/** At most this many earlier-named places are carried into the next turn. */
export const GUEST_REPLY_ANCHOR_LIMIT = 3
// A place counts as named when the reply covers this share of its name's identifying weight.
const MIN_WEIGHTED_COVERAGE = 0.55

function nameTokens(value: string): string[] {
  return [
    ...new Set(
      (normalizeGuestText(value).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (token) => !NAME_STOP_WORDS.has(token),
      ),
    ),
  ]
}

/**
 * Places the guide's previous reply named, so a follow-up keeps their details in context.
 *
 * Replies use everyday names ("the Orbiter Station water tank fragment") rather than catalogue titles
 * ("Orbiter Station Lab Water Tank Fragment"), so a place matches when the reply contains the
 * rarer words of its name, each weighted by how few of the venue's place names use it. Shared
 * gallery or kind words ("Orbiter", "Exhibit") weigh little, so one of them never names a place.
 * Same-name places are skipped: place-identity resolution decides which one a visitor means.
 */
export function guestPlacesNamedInReply<T extends { id: string; name: string }>(
  reply: string | null | undefined,
  places: readonly T[],
  limit = GUEST_REPLY_ANCHOR_LIMIT,
): T[] {
  if (!reply?.trim() || places.length === 0 || limit <= 0) return []
  const replyTokenList = (normalizeGuestText(reply).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => !NAME_STOP_WORDS.has(token),
  )
  const replyTokens = new Set(replyTokenList)
  // Whole-word sequence, so a short name never matches inside a longer word ("Ark" in "park").
  const replyWords = ` ${replyTokenList.join(' ')} `
  const nameCounts = new Map<string, number>()
  const tokenCounts = new Map<string, number>()
  const tokensByPlace = places.map((place) => {
    const tokens = nameTokens(place.name)
    const key = tokens.join(' ')
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
    for (const token of tokens) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1)
    return tokens
  })
  const weight = (token: string) => Math.log((places.length + 1) / (tokenCounts.get(token) ?? 1))
  const scored: Array<{ place: T; score: number; index: number }> = []
  places.forEach((place, index) => {
    const tokens = tokensByPlace[index]!
    if (tokens.length === 0 || (nameCounts.get(tokens.join(' ')) ?? 0) > 1) return
    const fullName = tokens.join(' ')
    if (fullName.length >= 4 && replyWords.includes(` ${fullName} `)) {
      scored.push({ place, score: 2, index })
      return
    }
    const matched = tokens.filter((token) => replyTokens.has(token))
    if (matched.length < 2) return
    const total = tokens.reduce((sum, token) => sum + weight(token), 0)
    const covered = matched.reduce((sum, token) => sum + weight(token), 0)
    const score = total > 0 ? covered / total : 0
    if (score >= MIN_WEIGHTED_COVERAGE) scored.push({ place, score, index })
  })
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ place }) => place)
}
