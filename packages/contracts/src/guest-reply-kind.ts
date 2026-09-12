/** Public presentation semantics; never expose internal provider/failure codes. */
export type GuestReplyKind = 'ANSWER' | 'TEMPORARY_FALLBACK'

export function guestReplyKindFromFallbackCode(
  fallbackCode: string | null | undefined,
): GuestReplyKind {
  // Legacy rows have no turn classification. A grounded lack of context is an
  // answer about available knowledge, not a temporary service outage.
  if (fallbackCode == null || fallbackCode === 'NO_RELEVANT_CONTEXT') return 'ANSWER'
  // Unknown future non-null failure codes must not gain answer-only controls.
  return 'TEMPORARY_FALLBACK'
}
