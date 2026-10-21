/**
 * Setup-time enrichment. A strong model reads records whose facts are in prose and proposes
 * structured claims. Nothing it says is trusted: each claim must quote its record verbatim, name
 * entities that already exist in the index, and carry values that appear in the quote. Rejected
 * claims are reported, never served. Results are keyed by record body hash, so editing a record
 * invalidates only that record's claims.
 */
import { linkText } from './guest-retrieval'
import { containsVerbatim, normalizeText, phraseKey } from './text'
import {
  RECORD_PREFIX,
  sha256,
  type EnrichmentClaim,
  type RecordEnrichment,
  type VenueIndex,
  type VenueSourceRecord,
} from './venue-index'

export const ENRICHMENT_FIELDS = [
  'height',
  'ages',
  'price',
  'hours',
  'reservation',
  'status',
  'access',
] as const

export type EnrichmentProposal =
  | { type: 'sells'; product: string; seller: string; quote: string }
  | { type: 'fact'; subject: string; field: string; value: string; quote: string }
  | { type: 'alias'; subject: string; alias: string }
  | { type: 'applies_to'; subject: string; quote: string }

export const ENRICHMENT_INSTRUCTIONS = `You prepare a venue's records for a visitor guide. For each record, list only claims the record itself states:
- sells: a product and where it is sold, when the text says so in prose (labeled "Sells:" lines are already parsed; skip them).
- fact: a height, ages, price, hours, reservation, status or access value for a named place or activity stated in this record about some OTHER named thing (for example a height chart listing several rides).
- applies_to: a named place, ride or activity this policy or topic applies to or makes an exception for.
- alias: ordinary words a visitor might use for a named thing in this record (for example "bathroom" for restroom, "service dog" for assistance animal). Aliases need no quote.
Every claim except alias must include "quote": an exact, unedited sentence or phrase copied from the record that states it. Use names exactly as written. Do not infer, generalize or add outside knowledge. Return JSON only:
{"records":[{"recordId":"...","claims":[{"type":"sells","product":"...","seller":"...","quote":"..."},{"type":"fact","subject":"...","field":"height","value":"...","quote":"..."},{"type":"applies_to","subject":"...","quote":"..."},{"type":"alias","subject":"...","alias":"..."}]}]}`

/** Records worth sending to the model: prose beyond labeled lines, or topics naming other entities. */
export function recordsNeedingEnrichment(index: VenueIndex): VenueSourceRecord[] {
  return [...index.records.values()].filter((record) => {
    const prose = record.body
      .split(/\r?\n/u)
      .slice(1)
      .filter((line) => !/^\s*[A-Z][A-Za-z ()-]{1,40}:\s/u.test(line))
    return prose.length > 0 || record.source === 'knowledge'
  })
}

function resolvesTo(index: VenueIndex, name: string): string[] {
  return index.resolveKey(phraseKey(name)).filter((id) => index.entity(id) !== null)
}

function numbers(value: string): string[] {
  return value.match(/\d+(?:[.:]\d+)?/gu) ?? []
}

export function validateEnrichment(
  index: VenueIndex,
  record: VenueSourceRecord,
  proposals: EnrichmentProposal[],
): {
  enrichment: RecordEnrichment
  rejected: Array<{ proposal: EnrichmentProposal; reason: string }>
} {
  const accepted: EnrichmentClaim[] = []
  const rejected: Array<{ proposal: EnrichmentProposal; reason: string }> = []
  const reject = (proposal: EnrichmentProposal, reason: string) =>
    rejected.push({ proposal, reason })
  const inQuote = (quote: string, phrase: string) =>
    ` ${normalizeText(quote)} `.includes(` ${normalizeText(phrase)} `)
  for (const proposal of proposals) {
    if (proposal.type === 'alias') {
      const targets = resolvesTo(index, proposal.subject)
      const alias = proposal.alias.trim()
      if (targets.length !== 1)
        reject(proposal, targets.length ? 'subject is ambiguous' : 'subject not found')
      else if (!alias || alias.split(/\s+/u).length > 6) reject(proposal, 'alias empty or too long')
      else {
        const existing = index.resolveKey(phraseKey(alias))
        if (existing.length && !existing.includes(targets[0]!))
          reject(proposal, 'alias already names something else')
        else accepted.push({ type: 'alias', targetKey: phraseKey(proposal.subject), alias })
      }
      continue
    }
    if (!proposal.quote || !containsVerbatim(record.body, proposal.quote)) {
      reject(proposal, 'quote is not verbatim in the record')
      continue
    }
    if (proposal.type === 'sells') {
      if (!inQuote(proposal.quote, proposal.product)) reject(proposal, 'product not in quote')
      else if (!inQuote(proposal.quote, proposal.seller) && !inQuote(record.title, proposal.seller))
        reject(proposal, 'seller not in quote')
      else {
        const seller = linkText(index, proposal.seller)
          .flatMap((mention) => mention.entityIds)
          .find((id) => id.startsWith(RECORD_PREFIX))
        accepted.push({
          type: 'sells',
          productDisplay: proposal.product,
          seller: proposal.seller,
          sellerTargetKey: seller ? phraseKey(index.entity(seller)?.name ?? '') : null,
          span: proposal.quote,
        })
      }
    } else if (proposal.type === 'fact') {
      const field = proposal.field.toLowerCase()
      if (!(ENRICHMENT_FIELDS as readonly string[]).includes(field))
        reject(proposal, 'field not allowed')
      else if (!resolvesTo(index, proposal.subject).length) reject(proposal, 'subject not found')
      else if (!inQuote(proposal.quote, proposal.subject)) reject(proposal, 'subject not in quote')
      else if (numbers(proposal.value).some((number) => !numbers(proposal.quote).includes(number)))
        reject(proposal, 'value not in quote')
      else
        accepted.push({
          type: 'fact',
          targetKey: phraseKey(proposal.subject),
          field,
          value: proposal.value,
          span: proposal.quote,
        })
    } else if (proposal.type === 'applies_to') {
      if (!resolvesTo(index, proposal.subject).length) reject(proposal, 'subject not found')
      else if (!inQuote(proposal.quote, proposal.subject)) reject(proposal, 'subject not in quote')
      else
        accepted.push({
          type: 'applies_to',
          targetKey: phraseKey(proposal.subject),
          span: proposal.quote,
        })
    }
  }
  return {
    enrichment: { recordId: record.id, bodySha256: sha256(record.body), claims: accepted },
    rejected,
  }
}
