/**
 * Setup-time enrichment. A strong model reads records whose facts are in prose and proposes
 * structured claims. Nothing it says is trusted: each claim must quote its record verbatim, name
 * entities that already exist in the index, and carry values that appear in the quote. Rejected
 * claims are reported, never served. Results are keyed by record body hash, so editing a record
 * invalidates only that record's claims.
 */
import { GUEST_KIND_WORD_SET, linkText } from './guest-retrieval'
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
  'when',
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

/** Resolve a claim's subject. A record sharing its name with an area is the same thing. */
function resolveSubject(index: VenueIndex, name: string): { id: string } | { reason: string } {
  const targets = index.resolveKey(phraseKey(name)).filter((id) => index.entity(id) !== null)
  const records = targets.filter((id) => id.startsWith(RECORD_PREFIX))
  if (records.length === 1) return { id: records[0]! }
  if (records.length === 0 && targets.length === 1) return { id: targets[0]! }
  return { reason: targets.length ? 'subject is ambiguous' : 'subject not found' }
}

function numbers(value: string): string[] {
  return value.match(/\d+(?:[.:]\d+)?/gu) ?? []
}

const FIELD_ALIASES: Record<string, string> = { time: 'when', times: 'when', when: 'when' }

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
    phrase.trim().length > 0 && ` ${normalizeText(quote)} `.includes(` ${normalizeText(phrase)} `)
  // Pass 1: aliases. They only help retrieval, so they need no quote, but they must name one
  // existing thing, must not be a general category word, and must not already name something else.
  const namesOf = new Map<string, string[]>()
  const names = (id: string) => {
    if (!namesOf.has(id)) {
      const own = id.startsWith(RECORD_PREFIX)
        ? (index.contributions.get(id.slice(RECORD_PREFIX.length))?.aliases ?? [])
        : [index.entity(id)?.name ?? '']
      // Aliases already validated from other records ("planetarium" from the planetarium's page).
      const learned = [...index.enrichmentAliases.entries()]
        .filter(([, targets]) =>
          [...targets].some((value) =>
            index.resolveKey(value.split('\u0000')[0] ?? '').includes(id),
          ),
        )
        .map(([aliasKey]) => aliasKey)
      namesOf.set(id, [...own, ...learned])
    }
    return namesOf.get(id)!
  }
  const isPlace = (id: string) =>
    id.startsWith(RECORD_PREFIX) &&
    index.records.get(id.slice(RECORD_PREFIX.length))?.source === 'place'
  const nameTokens = (id: string) => new Set(phraseKey(index.entity(id)?.name ?? '').split(' '))
  for (const proposal of proposals) {
    if (proposal.type !== 'alias') continue
    const subject = resolveSubject(index, proposal.subject)
    const alias = proposal.alias.trim()
    const tokens = phraseKey(alias).split(' ')
    if ('reason' in subject) reject(proposal, subject.reason)
    else if (!alias || tokens.length > 6) reject(proposal, 'alias empty or too long')
    else if (tokens.length === 1 && GUEST_KIND_WORD_SET.has(tokens[0] ?? ''))
      reject(proposal, 'alias is a general category word')
    else if (
      isPlace(subject.id) &&
      GUEST_KIND_WORD_SET.has(tokens[tokens.length - 1] ?? '') &&
      !tokens.some((token) => nameTokens(subject.id).has(token))
    )
      reject(proposal, 'alias is a category phrase for one place')
    else {
      const existing = index.resolveKey(phraseKey(alias))
      if (existing.length && !existing.includes(subject.id))
        reject(proposal, 'alias already names something else')
      else {
        accepted.push({ type: 'alias', targetKey: phraseKey(proposal.subject), alias })
        names(subject.id).push(alias)
      }
    }
  }
  // Pass 2: claims about facts must quote the record and name their subject in the quote.
  const mentioned = (quote: string, id: string) => names(id).some((name) => inQuote(quote, name))
  for (const proposal of proposals) {
    if (proposal.type === 'alias') continue
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
      continue
    }
    const subject = resolveSubject(index, proposal.subject)
    if ('reason' in subject) {
      reject(proposal, subject.reason)
      continue
    }
    if (!mentioned(proposal.quote, subject.id)) {
      reject(proposal, 'subject not in quote')
      continue
    }
    if (proposal.type === 'fact') {
      const field = FIELD_ALIASES[proposal.field.toLowerCase()] ?? proposal.field.toLowerCase()
      if (!(ENRICHMENT_FIELDS as readonly string[]).includes(field))
        reject(proposal, 'field not allowed')
      else if (numbers(proposal.value).some((number) => !numbers(proposal.quote).includes(number)))
        reject(proposal, 'value not in quote')
      else
        accepted.push({
          type: 'fact',
          targetKey: phraseKey(index.entity(subject.id)?.name ?? proposal.subject),
          field,
          value: proposal.value,
          span: proposal.quote,
        })
    } else if (proposal.type === 'applies_to') {
      accepted.push({
        type: 'applies_to',
        targetKey: phraseKey(index.entity(subject.id)?.name ?? proposal.subject),
        span: proposal.quote,
      })
    }
  }
  return {
    enrichment: { recordId: record.id, bodySha256: sha256(record.body), claims: accepted },
    rejected,
  }
}

export type CachedProposals = { recordId: string; bodySha256: string; claims: EnrichmentProposal[] }

/**
 * Apply cached model proposals to an index. Proposals made from a different version of a record
 * are skipped as stale (that record needs re-enrichment). Aliases from every record are learned
 * first, so a fact can name its subject by an alias another record supplied.
 */
export function applyEnrichmentProposals(
  index: VenueIndex,
  cached: CachedProposals[],
): {
  applied: number
  stale: string[]
  accepted: number
  rejected: Array<{ recordId: string; proposal: EnrichmentProposal; reason: string }>
} {
  const current = cached.filter((item) => {
    const record = index.records.get(item.recordId)
    return record !== undefined && sha256(record.body) === item.bodySha256
  })
  const stale = cached
    .filter((item) => index.records.has(item.recordId) && !current.includes(item))
    .map((item) => item.recordId)
  for (const item of current) {
    const record = index.records.get(item.recordId)!
    const aliases = item.claims.filter((claim) => claim.type === 'alias')
    index.setEnrichment(validateEnrichment(index, record, aliases).enrichment)
  }
  let accepted = 0
  const rejected: Array<{ recordId: string; proposal: EnrichmentProposal; reason: string }> = []
  for (const item of current) {
    const record = index.records.get(item.recordId)!
    const result = validateEnrichment(index, record, item.claims)
    index.setEnrichment(result.enrichment)
    accepted += result.enrichment.claims.length
    for (const entry of result.rejected) rejected.push({ recordId: item.recordId, ...entry })
  }
  return { applied: current.length, stale, accepted, rejected }
}
