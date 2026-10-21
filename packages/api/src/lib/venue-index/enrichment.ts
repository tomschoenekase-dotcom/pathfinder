/**
 * Setup-time enrichment. A strong model reads records whose facts are in prose and proposes
 * structured claims. Proposals select whole source bodies for retrieval only. A quote locates evidence;
 * it does not establish sale polarity, fact values or governing relationships. Source metadata and
 * resolved target fingerprints invalidate stale hints without promoting proposals into facts.
 */
import { GUEST_KIND_WORD_SET } from './guest-retrieval'
import { containsVerbatim, normalizeText, phraseKey } from './text'
import {
  RECORD_PREFIX,
  sha256,
  proposalSourceFingerprint,
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

const FIELD_ALIASES: Record<string, string> = { time: 'when', times: 'when', when: 'when' }

function validProposal(value: unknown): value is EnrichmentProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const p = value as Record<string, unknown>
  const shape =
    p.type === 'sells'
      ? ['type', 'product', 'seller', 'quote']
      : p.type === 'fact'
        ? ['type', 'subject', 'field', 'value', 'quote']
        : p.type === 'alias'
          ? ['type', 'subject', 'alias']
          : p.type === 'applies_to'
            ? ['type', 'subject', 'quote']
            : []
  return (
    shape.length > 0 &&
    Object.keys(p).length === shape.length &&
    shape.every(
      (key) =>
        typeof p[key] === 'string' &&
        !!(p[key] as string).trim() &&
        (p[key] as string).length <= (key === 'quote' ? 20000 : 2048),
    )
  )
}

/** Compatibility name: validates evidence location, never semantic entailment or authority. */
export function validateEnrichment(
  index: VenueIndex,
  record: VenueSourceRecord,
  proposals: EnrichmentProposal[],
): {
  enrichment: RecordEnrichment
  rejected: Array<{ proposal: EnrichmentProposal; reason: string }>
} {
  if (!Array.isArray(proposals) || proposals.length > 100)
    throw new Error('Invalid enrichment proposal bound')
  const claims: EnrichmentClaim[] = []
  const rejected: Array<{ proposal: EnrichmentProposal; reason: string }> = []
  const targets = new Map<string, string>()
  const reject = (proposal: EnrichmentProposal, reason: string) =>
    rejected.push({ proposal, reason })
  // Only original source identity names resolve a subject. Proposed aliases never feed validation.
  const inQuote = (quote: string, phrase: string) =>
    phrase.trim().length > 0 && ` ${normalizeText(quote)} `.includes(` ${normalizeText(phrase)} `)
  for (const proposal of proposals) {
    if (!validProposal(proposal)) {
      reject(proposal, 'invalid proposal shape')
      continue
    }
    if (proposal.type !== 'alias' && !containsVerbatim(record.body, proposal.quote)) {
      reject(proposal, 'quote is not verbatim in the record')
      continue
    }
    if (proposal.type === 'sells') {
      if (!inQuote(proposal.quote, proposal.product)) {
        reject(proposal, 'product not in quote')
        continue
      }
      if (!inQuote(proposal.quote, proposal.seller) && !inQuote(record.title, proposal.seller)) {
        reject(proposal, 'seller not in quote')
        continue
      }
      const seller = resolveSubject(index, proposal.seller)
      if (!('reason' in seller) && seller.id.startsWith(RECORD_PREFIX)) {
        const target = index.records.get(seller.id.slice(RECORD_PREFIX.length))!
        targets.set(target.id, proposalSourceFingerprint(target))
      }
      claims.push({
        type: 'sells',
        productDisplay: proposal.product,
        seller: proposal.seller,
        sellerTargetKey: null,
        span: proposal.quote,
      })
      continue
    }
    const subject = resolveSubject(index, proposal.subject)
    if ('reason' in subject) {
      reject(proposal, subject.reason)
      continue
    }
    // Area-only/model aliases are not stable subject identities for proposals.
    const target = subject.id.startsWith(RECORD_PREFIX)
      ? index.records.get(subject.id.slice(RECORD_PREFIX.length))
      : undefined
    if (!target) {
      reject(proposal, 'subject has no source identity')
      continue
    }
    if (proposal.type === 'alias') {
      const tokens = phraseKey(proposal.alias).split(' ')
      const existing = index.resolveKey(phraseKey(proposal.alias))
      if (
        proposal.alias.length > 128 ||
        tokens.length > 6 ||
        (tokens.length === 1 && GUEST_KIND_WORD_SET.has(tokens[0] ?? ''))
      ) {
        reject(proposal, 'alias empty, general or too long')
        continue
      }
      if (existing.length && !existing.includes(subject.id)) {
        reject(proposal, 'alias already names something else')
        continue
      }
      claims.push({ type: 'alias', targetKey: phraseKey(target.title), alias: proposal.alias })
    } else {
      const sourceNames = index.contributions.get(target.id)?.aliases ?? [target.title]
      if (!sourceNames.some((name) => inQuote(proposal.quote, name))) {
        reject(proposal, 'subject not in quote')
        continue
      }
      if (proposal.type === 'fact') {
        const field = FIELD_ALIASES[proposal.field.toLowerCase()] ?? proposal.field.toLowerCase()
        if (!(ENRICHMENT_FIELDS as readonly string[]).includes(field)) {
          reject(proposal, 'field not allowed')
          continue
        }
        // Value is unverified proposal text and is never used as an answer fact.
        claims.push({
          type: 'fact',
          targetKey: phraseKey(target.title),
          field,
          value: proposal.value,
          span: proposal.quote,
        })
      } else
        claims.push({
          type: 'applies_to',
          targetKey: phraseKey(target.title),
          span: proposal.quote,
        })
    }
    targets.set(target.id, proposalSourceFingerprint(target))
  }
  return {
    enrichment: {
      recordId: record.id,
      bodySha256: sha256(record.body),
      sourceFingerprint: proposalSourceFingerprint(record),
      targets: [...targets]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([recordId, fingerprint]) => ({ recordId, fingerprint })),
      claims,
    },
    rejected,
  }
}

export type CachedProposals = { recordId: string; bodySha256: string; claims: EnrichmentProposal[] }

/** Re-locate bounded legacy model proposals against current sources; never promote their authority. */
export function applyEnrichmentProposals(
  index: VenueIndex,
  cached: CachedProposals[],
): {
  applied: number
  stale: string[]
  accepted: number
  rejected: Array<{ recordId: string; proposal: EnrichmentProposal; reason: string }>
} {
  if (!Array.isArray(cached) || cached.length > 10000)
    throw new Error('Invalid cached proposal bound')
  let applied = 0
  let accepted = 0
  const stale: string[] = []
  const rejected: Array<{ recordId: string; proposal: EnrichmentProposal; reason: string }> = []
  for (const item of cached) {
    if (
      !item ||
      typeof item.recordId !== 'string' ||
      typeof item.bodySha256 !== 'string' ||
      !Array.isArray(item.claims)
    )
      throw new Error('Invalid cached proposals')
    const record = index.records.get(item.recordId)
    if (!record || sha256(record.body) !== item.bodySha256) {
      stale.push(item.recordId)
      continue
    }
    const result = validateEnrichment(index, record, item.claims)
    index.setEnrichment(result.enrichment)
    applied += 1
    accepted += result.enrichment.claims.length
    for (const entry of result.rejected) rejected.push({ recordId: item.recordId, ...entry })
  }
  return { applied, stale, accepted, rejected }
}
