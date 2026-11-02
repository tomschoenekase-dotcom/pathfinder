/**
 * COMPARE is server-detected: a ranking or comparison needs room for every item and its reason.
 * DEEP_DIVE is set only by evidence assembly for an explicit "tell me everything" request.
 */
export type GuestResponseIntent = 'DEFAULT' | 'EXPAND' | 'COMPARE' | 'DEEP_DIVE'

const COMPARISON_REQUEST =
  /\b(?:rank(?:ed|ing|s)?|compare[ds]?|comparing|comparison|versus|vs\.?|in order of|from (?:most|least|best|worst|mildest|tamest|wildest|scariest) to|(?:best|worst|most|least) to (?:best|worst|most|least)|differences? between|pros and cons|which (?:is|are|one is|ones are) (?:the )?(?:more|less|most|least|best|worst|scariest|wildest|mildest|tamest|fastest|tallest|biggest))\b/iu

export function guestResponseIntentForMessage(
  message: string,
  requested: 'DEFAULT' | 'EXPAND' | undefined,
): GuestResponseIntent {
  if (requested === 'EXPAND') return 'EXPAND'
  return COMPARISON_REQUEST.test(message) ? 'COMPARE' : 'DEFAULT'
}
