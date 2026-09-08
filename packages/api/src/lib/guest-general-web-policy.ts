/**
 * Server-only eligibility policy for an optional GENERAL background search.
 *
 * The enablement fields must come from server-controlled global/tenant/provider
 * state. Guest text never supplies authority. A SEARCH result only permits a
 * later bounded search attempt; it is not evidence that general information is
 * authoritative for the current venue, semantically safe, private, or suitable
 * to show in a response.
 */

export const GUEST_GENERAL_WEB_QUERY_MAX_CHARACTERS = 320

export type GuestGeneralWebSearchSkipReason =
  | 'GLOBAL_DISABLED'
  | 'TENANT_DISABLED'
  | 'PROVIDER_UNAVAILABLE'
  | 'LOCAL_CONTEXT_SUFFICIENT'
  | 'EMPTY_QUERY'
  | 'CONTROL_CHARACTER'
  | 'EMBEDDED_DESTINATION'
  | 'QUERY_TOO_LONG'
  | 'UNSUPPORTED_SCRIPT'
  | 'VENUE_OR_OPERATIONAL_REQUEST'
  | 'UNKNOWN_OR_AMBIGUOUS_INTENT'

export type GuestGeneralWebSearchDecision =
  | { kind: 'SKIP'; reason: GuestGeneralWebSearchSkipReason }
  | { kind: 'SEARCH'; normalizedQuery: string }

export type GuestGeneralWebPolicyInput = {
  /** Server-derived dark global capability. Missing is disabled. */
  globalEnabled?: boolean
  /** Server-derived tenant capability. Missing is disabled. */
  tenantEnabled?: boolean
  /** Server-derived provider readiness. Missing is unavailable. */
  providerAvailable?: boolean
  /** Server-derived local retrieval result. Missing is not sufficient. */
  localContextSufficient?: boolean
  query?: string | null
}

const GENERAL_INTENT =
  /^(?:what\s+(?:is|are)\b|how\s+(?:does|do)\b|why\s+(?:is|are|does|do)\b|who\s+(?:is|are|was|were)\b|explain\b|define\b)/iu

// These topics need scoped venue truth or a local answer. Do not infer that a
// general phrasing makes them safe to search or answer from broad background data.
const VENUE_SENSITIVE_TOPIC =
  /\b(?:hours?|opening|closing|schedule|today|tomorrow|current|now|open|closed|price|prices|cost|ticket|tickets|admission|fee|fees|access|accessible|accessibility|wheelchair|location|directions?|address|parking|nearest|nearby|route|safety|safe|security|emergency|evacuation|eligib(?:le|ility)|policy|policies|rules?|allowed|prohibited|permit(?:ted|s)?)\b/iu

// Deictic or personal language makes a query venue-contextual even when it
// begins with an otherwise general English question form.
const VENUE_CONTEXT_REFERENCE =
  /\b(?:i|me|my|mine|we|us|our|ours|you|your|yours|here|there|this|that|these|those)\b/iu
const EXPLICIT_DESTINATION =
  /\b(?:https?:\/\/|www\.|mailto:)\S+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu
const LETTER = /\p{Letter}/u
const LATIN_LETTER = /\p{Script=Latin}/u

function normalizeQuery(query: string | null | undefined): string {
  return (query ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ')
}

function containsUnsupportedScript(query: string): boolean {
  // This bounds eligibility to Latin-script text; it does not identify English
  // or provide multilingual semantic coverage.
  return [...query].some((character) => LETTER.test(character) && !LATIN_LETTER.test(character))
}

function containsControlCharacter(query: string): boolean {
  return [...query].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
  })
}

export function decideGuestGeneralWebSearch(
  input: GuestGeneralWebPolicyInput,
): GuestGeneralWebSearchDecision {
  if (input.globalEnabled !== true) return { kind: 'SKIP', reason: 'GLOBAL_DISABLED' }
  if (input.tenantEnabled !== true) return { kind: 'SKIP', reason: 'TENANT_DISABLED' }
  if (input.providerAvailable !== true) return { kind: 'SKIP', reason: 'PROVIDER_UNAVAILABLE' }
  if (input.localContextSufficient === true)
    return { kind: 'SKIP', reason: 'LOCAL_CONTEXT_SUFFICIENT' }

  const normalizedQuery = normalizeQuery(input.query)
  if (!normalizedQuery) return { kind: 'SKIP', reason: 'EMPTY_QUERY' }
  if (containsControlCharacter(input.query ?? ''))
    return { kind: 'SKIP', reason: 'CONTROL_CHARACTER' }
  if (EXPLICIT_DESTINATION.test(normalizedQuery))
    return { kind: 'SKIP', reason: 'EMBEDDED_DESTINATION' }
  if ([...normalizedQuery].length > GUEST_GENERAL_WEB_QUERY_MAX_CHARACTERS)
    return { kind: 'SKIP', reason: 'QUERY_TOO_LONG' }
  if (containsUnsupportedScript(normalizedQuery))
    return { kind: 'SKIP', reason: 'UNSUPPORTED_SCRIPT' }
  if (VENUE_SENSITIVE_TOPIC.test(normalizedQuery) || VENUE_CONTEXT_REFERENCE.test(normalizedQuery))
    return { kind: 'SKIP', reason: 'VENUE_OR_OPERATIONAL_REQUEST' }
  if (!GENERAL_INTENT.test(normalizedQuery))
    return { kind: 'SKIP', reason: 'UNKNOWN_OR_AMBIGUOUS_INTENT' }

  return { kind: 'SEARCH', normalizedQuery }
}
