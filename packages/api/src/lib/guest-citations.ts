export type GuestCitationCandidate = {
  entityId: string
  entityLabel: string
  entityKind: 'place' | 'knowledge'
  sourceType?: string | null
  sourceName?: string | null
  sourceUrl?: string | null
}

export type GuestCitation = { label: string; href?: string; detail: string }

const secretKey = /(?:token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-)/iu

function safeSourceUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      return undefined
    const keys = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()]
    return keys.some((key) => secretKey.test(key)) ? undefined : url.toString()
  } catch {
    return undefined
  }
}

const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US')
const isLetterOrNumber = (value: string | undefined) =>
  value ? /[\p{L}\p{N}]/u.test(value) : false

function explicitlyNames(answer: string, entityLabel: string): boolean {
  const label = normalized(entityLabel)
  if (!label) return false
  let offset = answer.indexOf(label)
  while (offset >= 0) {
    const before = Array.from(answer.slice(0, offset)).at(-1)
    const after = Array.from(answer.slice(offset + label.length))[0]
    if (!isLetterOrNumber(before) && !isLetterOrNumber(after)) return true
    offset = answer.indexOf(label, offset + label.length)
  }
  return false
}

/**
 * Projects provenance only for retrieved entities explicitly named in the visible answer. This is
 * deterministic evidence, not a claim-level semantic attribution: unmentioned or unproven sources
 * are omitted, and unsafe source URLs are never returned.
 */
export function buildGuestCitations(input: {
  assistantResponse: string
  candidates: readonly GuestCitationCandidate[]
  maximum?: number
}): GuestCitation[] {
  const answer = normalized(input.assistantResponse)
  const maximum = Math.max(0, Math.min(12, Math.floor(input.maximum ?? 6)))
  const citations = new Map<string, GuestCitation>()
  for (const candidate of input.candidates) {
    if (citations.size >= maximum) break
    const entityLabel = candidate.entityLabel.trim()
    if (!entityLabel || !explicitlyNames(answer, entityLabel)) continue
    const sourceName = candidate.sourceName?.trim() || null
    const href = safeSourceUrl(candidate.sourceUrl)
    if (
      !sourceName &&
      !href &&
      (candidate.sourceType ?? 'UNKNOWN').trim().toUpperCase() === 'UNKNOWN'
    )
      continue
    const label = sourceName ?? `${entityLabel} source`
    const detail = `${candidate.entityKind === 'place' ? 'Place' : 'Venue knowledge'}: ${entityLabel}`
    const key = JSON.stringify([label, href ?? null, detail])
    citations.set(key, { label, ...(href ? { href } : {}), detail })
  }
  return [...citations.values()]
}

/** Marks general web background, which stays attributed because it is not venue authority. */
export const GENERAL_BACKGROUND_CITATION_DETAIL = 'General background'

const MAX_REQUESTED_VENUE_LINKS = 2

// The visitor asked for somewhere to go next: a page, a booking or purchase, or a ticket destination.
// Mentioning an existing ticket in a policy question is not a link request. Ordering is left to the
// venue's approved guest actions: a dining page is not a way to order.
const VISITOR_LINK_REQUEST =
  /\b(?:links?|urls?|websites?|web ?pages?|web ?sites?|official (?:site|page)|(?:the|its|their|a) (?:site|page)|book(?:ing)?|reserv(?:e|ations?)|buy(?:ing)?|purchas(?:e|ing)|(?:get|find)\s+(?:(?:a|the|my|our)\s+)?tickets?|tickets?\s+(?:link|url|website|web ?page|web ?site)|sign ?up|register)\b/iu

export type GuestVisibleCitations = {
  heading: 'sources' | 'links'
  citations: GuestCitation[]
}

/**
 * Which stored citations a visitor sees. Venue provenance is kept for evidence and review, but
 * a routine bibliography of pages the answer already summarized is noise on a phone. A venue
 * source page is shown only when the visitor asked for a page, booking, purchase or order, and
 * then only as a link. General web background stays attributed.
 */
export function selectGuestVisibleCitations(input: {
  visitorMessage: string
  citations: readonly { label: string; href?: string | undefined; detail?: string | undefined }[]
}): GuestVisibleCitations | null {
  const general = input.citations.filter(
    (citation) => citation.detail === GENERAL_BACKGROUND_CITATION_DETAIL,
  )
  const requested = new Map<string, GuestCitation>()
  if (VISITOR_LINK_REQUEST.test(input.visitorMessage)) {
    for (const citation of input.citations) {
      if (requested.size >= MAX_REQUESTED_VENUE_LINKS) break
      if (citation.detail === GENERAL_BACKGROUND_CITATION_DETAIL || !citation.href) continue
      if (requested.has(citation.href)) continue
      // Name the destination by what it is about, not by the research record's source title.
      const name = (citation.detail ?? citation.label)
        .replace(/^(?:Place|Venue knowledge): /u, '')
        .replace(/:\s*visitor information$/iu, '')
      requested.set(citation.href, {
        label: name,
        href: citation.href,
        detail: citation.detail ?? name,
      })
    }
  }
  const citations = [
    ...requested.values(),
    ...general.map((citation) => ({
      label: citation.label,
      ...(citation.href ? { href: citation.href } : {}),
      detail: citation.detail ?? citation.label,
    })),
  ]
  if (citations.length === 0) return null
  return { heading: general.length ? 'sources' : 'links', citations }
}
