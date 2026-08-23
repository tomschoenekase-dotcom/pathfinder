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
