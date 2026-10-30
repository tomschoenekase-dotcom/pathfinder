/**
 * Queryable venue index. Derived only from records the guest is already authorized to read, so
 * tenant, visibility and publication rules stay where they are. Every structure here is a sum of
 * per-record contributions: adding, changing or withdrawing one record subtracts its old
 * contribution and adds the new one. Links between records are stored as names and resolved at
 * query time, so a withdrawn target can never leave a dangling edge behind.
 */
import { createHash } from 'node:crypto'

import {
  containsVerbatim,
  isStopword,
  normalizeText,
  phraseKey,
  singleDeletions,
  stem,
  stemTokens,
} from './text'

export type VenueSourceRecord = {
  id: string
  source: 'place' | 'knowledge'
  title: string
  body: string
  category: string | null
  areaName: string | null
  placeType: string | null
  itemType: string | null
  tags: string[]
  hours: string | null
}

export type EntityKind =
  | 'ride'
  | 'exhibit'
  | 'show'
  | 'stage'
  | 'food'
  | 'shop'
  | 'restroom'
  | 'service'
  | 'activity'
  | 'place'
  | 'event'
  | 'animal'
  | 'collection'
  | 'topic'
  | 'product'
  | 'species'
  | 'area'

export type RecordLabel = { label: string; value: string; line: string }

export type SoldItem = {
  productKey: string
  display: string
  price: string | null
  notes: string[]
  span: string
}

/** Untrusted retrieval proposal. A located quote never establishes semantic truth. */
export type EnrichmentClaim =
  | {
      type: 'sells'
      productDisplay: string
      seller: string
      sellerTargetKey: string | null
      span: string
    }
  | { type: 'fact'; targetKey: string; field: string; value: string; span: string }
  | { type: 'alias'; targetKey: string; alias: string }
  | { type: 'applies_to'; targetKey: string; span: string }

export type RecordEnrichment = {
  recordId: string
  bodySha256: string
  claims: EnrichmentClaim[]
  sourceFingerprint?: string
  targets?: Array<{ recordId: string; fingerprint: string }>
}

/** Metadata as well as body text participates in proposal invalidation. */
export const proposalSourceFingerprint = (record: VenueSourceRecord): string =>
  sha256(
    JSON.stringify([
      record.id,
      record.source,
      record.title,
      record.body,
      record.category,
      record.areaName,
      record.placeType,
      record.itemType,
      record.tags,
      record.hours,
    ]),
  )

/** Runtime gate also covers callers bypassing validateEnrichment via build/setEnrichment. */
function locatedProposals(
  record: VenueSourceRecord,
  value: RecordEnrichment | undefined,
): EnrichmentClaim[] {
  if (
    !value ||
    value.recordId !== record.id ||
    value.bodySha256 !== sha256(record.body) ||
    value.sourceFingerprint !== proposalSourceFingerprint(record) ||
    !Array.isArray(value.claims) ||
    value.claims.length > 100 ||
    !Array.isArray(value.targets) ||
    value.targets.length > 100 ||
    value.targets.some(
      (target) =>
        !target ||
        typeof target.recordId !== 'string' ||
        typeof target.fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(target.fingerprint),
    )
  )
    return []
  const text = (v: unknown, max = 2048): v is string =>
    typeof v === 'string' && !!v.trim() && v.length <= max
  return value.claims.filter((claim) => {
    if (!claim || typeof claim !== 'object') return false
    if (claim.type === 'alias') return text(claim.alias, 128) && text(claim.targetKey)
    if (
      !('span' in claim) ||
      !text(claim.span, 20000) ||
      !containsVerbatim(record.body, claim.span)
    )
      return false
    if (claim.type === 'sells') return text(claim.productDisplay) && text(claim.seller)
    if (claim.type === 'fact')
      return text(claim.targetKey) && text(claim.field, 128) && text(claim.value)
    return claim.type === 'applies_to' && text(claim.targetKey)
  })
}

export type Contribution = {
  recordId: string
  entityId: string
  kind: EntityKind
  name: string
  aliases: string[]
  aliasKeys: string[]
  labels: RecordLabel[]
  areaKey: string | null
  areaDisplay: string | null
  sold: SoldItem[]
  speciesKeys: Array<{ key: string; display: string }>
  livesInKeys: string[]
  appliesToKeys: string[]
  valueKeys: string[]
  terms: Map<string, number>
  length: number
  bodySha256: string
  enrichment: EnrichmentClaim[]
}

export const AREA_PREFIX = 'area:'
export const PRODUCT_PREFIX = 'product:'
export const SPECIES_PREFIX = 'species:'
export const RECORD_PREFIX = 'rec:'

const LIST_LABELS = new Set(['features', 'access', 'applies to'])

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function parseLabels(body: string): RecordLabel[] {
  const labels: RecordLabel[] = []
  for (const line of body.split(/\r?\n/u)) {
    const match = /^\s*([A-Z][A-Za-z ()-]{1,40}):\s+(.+?)\s*$/u.exec(line)
    if (!match?.[1] || !match[2]) continue
    labels.push({ label: match[1].toLowerCase(), value: match[2], line })
  }
  return labels
}

function splitList(value: string): string[] {
  return value
    .split(/;\s*/u)
    .map((part) => part.trim())
    .filter(Boolean)
}

/** "Dippin\u2019 Dots ($7)", "Pad thai ($13, contains peanuts)", "Prints (from $8)". */
export function parseSold(value: string): SoldItem[] {
  return splitList(value).flatMap((part) => {
    const match = /^(.*?)\s*\(([^()]*)\)\s*$/u.exec(part)
    const display = (match?.[1] ?? part).trim()
    const inner = match?.[2] ?? ''
    const pieces = inner
      .split(/,\s*/u)
      .map((piece) => piece.trim())
      .filter(Boolean)
    const price = pieces.find((piece) => /\$\s?\d/u.test(piece)) ?? null
    const notes = pieces.filter((piece) => piece !== price)
    const productKey = phraseKey(display)
    return productKey ? [{ productKey, display, price, notes, span: part }] : []
  })
}

function classify(record: VenueSourceRecord, labels: RecordLabel[]): EntityKind {
  const tags = new Set(record.tags.map((tag) => tag.toLowerCase()))
  const has = (name: string) => labels.some((label) => label.label === name)
  if (record.source === 'place') {
    const type = (record.placeType ?? '').toUpperCase()
    if (type === 'RESTAURANT' || tags.has('food')) return 'food'
    if (type === 'SHOP' || tags.has('shop')) return 'shop'
    if (type === 'RESTROOM' || tags.has('restroom')) return 'restroom'
    if (type === 'SERVICE' || tags.has('service')) return 'service'
    for (const kind of ['ride', 'exhibit', 'show', 'stage', 'activity'] as const)
      if (tags.has(kind)) return kind
    if ((record.itemType ?? '') === 'exhibit') return 'exhibit'
    return 'place'
  }
  if (has('lives in')) return 'animal'
  if (has('when') || has('shows') || has('schedule')) return 'event'
  if (
    /\b(consists of|includes|has (\d+|[a-z]+) [a-z ]*?(booths|trucks|stops|rides|exhibits))\b/u.test(
      record.body.toLowerCase(),
    )
  )
    return 'collection'
  return 'topic'
}

function addCount(map: Map<string, number>, key: string, by = 1): void {
  const next = (map.get(key) ?? 0) + by
  if (next === 0) map.delete(key)
  else map.set(key, next)
}

export function passageText(record: VenueSourceRecord, kind: EntityKind): string {
  return [kind, record.areaName ?? '', record.title, record.body].join(' \n')
}

export function buildContribution(
  record: VenueSourceRecord,
  enrichment: RecordEnrichment | undefined,
): Contribution {
  const labels = parseLabels(record.body)
  const kind = classify(record, labels)
  const value = (name: string) =>
    labels.filter((label) => label.label === name).map((label) => label.value)
  const aliases = [record.title, ...value('also called').flatMap(splitList)]
  // "Velvet Harbor at Main Stage", "Meet an Astronaut - Saturday October 24": the subject alone is a name too.
  const subject = /^(.{3,80}?)\s+(?:at|[\u2014\u2013:-])\s+\S/u.exec(record.title)?.[1]
  if (record.source === 'knowledge' && subject) aliases.push(subject)
  const bodySha256 = sha256(record.body)
  const claims = locatedProposals(record, enrichment)
  const aliasKeys = [
    ...new Set(
      aliases.flatMap((alias) => {
        const key = phraseKey(alias)
        const bare = key.replace(/^the /u, '')
        return [key, bare].filter(
          (candidate) => candidate && candidate.split(' ').some((token) => !isStopword(token)),
        )
      }),
    ),
  ]
  const areaDisplay = record.areaName?.trim() || value('location')[0] || null
  const sold = value('sells').flatMap(parseSold)
  const speciesKeys = value('animals')
    .flatMap(splitList)
    .map((display) => ({ key: phraseKey(display), display }))
    .filter((entry) => entry.key)
  const valueKeys = new Set<string>()
  for (const label of labels)
    if (LIST_LABELS.has(label.label) || label.label === 'features')
      for (const item of splitList(label.value)) {
        const key = phraseKey(item.replace(/:.*$/u, ''))
        if (key) valueKeys.add(key)
      }
  for (const item of sold) for (const note of item.notes) valueKeys.add(phraseKey(note))
  const terms = new Map<string, number>()
  const tokens = stemTokens(passageText(record, kind))
  for (const token of tokens) if (!isStopword(token)) addCount(terms, token)
  for (const alias of aliasKeys)
    for (const token of alias.split(' ')) if (!isStopword(token)) addCount(terms, token)
  return {
    recordId: record.id,
    entityId: RECORD_PREFIX + record.id,
    kind,
    name: record.title,
    aliases: [...new Set(aliases)],
    aliasKeys,
    labels,
    areaKey: areaDisplay ? phraseKey(areaDisplay) : null,
    areaDisplay,
    sold,
    speciesKeys,
    livesInKeys: value('lives in').flatMap(splitList).map(phraseKey).filter(Boolean),
    appliesToKeys: [...value('applies to').flatMap(splitList).map(phraseKey)].filter(Boolean),
    valueKeys: [...valueKeys].filter(Boolean),
    terms,
    length: tokens.length,
    bodySha256,
    enrichment: claims,
  }
}

type Registry = Map<string, Map<string, string>> // key -> recordId -> display

function registryAdd(registry: Registry, key: string, recordId: string, display: string): void {
  let entry = registry.get(key)
  if (!entry) registry.set(key, (entry = new Map()))
  entry.set(recordId, display)
}

function registryRemove(registry: Registry, key: string, recordId: string): void {
  const entry = registry.get(key)
  if (!entry) return
  entry.delete(recordId)
  if (!entry.size) registry.delete(key)
}

function setAdd(map: Map<string, Set<string>>, key: string, value: string): void {
  let entry = map.get(key)
  if (!entry) map.set(key, (entry = new Set()))
  entry.add(value)
}

function setRemove(map: Map<string, Set<string>>, key: string, value: string): void {
  const entry = map.get(key)
  if (!entry) return
  entry.delete(value)
  if (!entry.size) map.delete(key)
}

export type IndexedEntity = {
  id: string
  kind: EntityKind
  name: string
  recordId: string | null
  areaKey: string | null
}

export class VenueIndex {
  readonly venueName: string
  readonly records = new Map<string, VenueSourceRecord>()
  readonly contributions = new Map<string, Contribution>()
  /** alias key -> entity id -> number of contributing records */
  readonly aliases = new Map<string, Map<string, number>>()
  readonly products: Registry = new Map()
  readonly species: Registry = new Map()
  readonly areas: Registry = new Map()
  readonly byKind = new Map<string, Set<string>>()
  readonly byArea = new Map<string, Set<string>>()
  readonly byValue = new Map<string, Set<string>>()
  readonly sellersByProduct = new Map<string, Set<string>>()
  readonly bySpecies = new Map<string, Set<string>>()
  readonly livesIn = new Map<string, Set<string>>()
  readonly appliesTo = new Map<string, Set<string>>()
  readonly enrichmentSellers = new Map<string, Set<string>>()
  readonly enrichmentFacts = new Map<string, Set<string>>()
  readonly enrichmentAliases = new Map<string, Set<string>>()
  readonly postings = new Map<string, Map<string, number>>()
  totalLength = 0
  private enrichmentByRecord = new Map<string, RecordEnrichment>()
  private fuzzyCache: { vocabulary: Map<string, Set<string>> } | null = null
  private aliasFirstToken: Map<string, Set<string>> | null = null

  constructor(venueName: string) {
    this.venueName = venueName
  }

  static build(
    venueName: string,
    records: VenueSourceRecord[],
    enrichment: RecordEnrichment[] = [],
  ): VenueIndex {
    const index = new VenueIndex(venueName)
    for (const item of enrichment) index.setEnrichment(item)
    for (const record of [...records].sort((a, b) => a.id.localeCompare(b.id))) index.upsert(record)
    return index
  }

  setEnrichment(item: RecordEnrichment): void {
    if (
      !item ||
      typeof item.recordId !== 'string' ||
      !item.recordId.trim() ||
      item.recordId.length > 512 ||
      !Array.isArray(item.claims) ||
      item.claims.length > 100
    )
      throw new Error('Invalid enrichment cache')
    this.enrichmentByRecord.set(item.recordId, structuredClone(item))
    const record = this.records.get(item.recordId)
    if (record) this.upsert(record)
  }

  enrichmentFor(recordId: string): RecordEnrichment | undefined {
    const value = this.enrichmentByRecord.get(recordId)
    return value ? structuredClone(value) : undefined
  }

  /** Add or replace one record. Only this record's own contribution is recomputed. */
  upsert(record: VenueSourceRecord): void {
    if (this.records.has(record.id)) this.withdraw(record.id)
    const contribution = buildContribution(record, this.enrichmentByRecord.get(record.id))
    this.records.set(record.id, record)
    this.contributions.set(record.id, contribution)
    this.apply(contribution, 1)
  }

  /** Remove one record and everything it contributed. */
  withdraw(recordId: string): boolean {
    const contribution = this.contributions.get(recordId)
    if (!contribution) return false
    this.apply(contribution, -1)
    this.contributions.delete(recordId)
    this.records.delete(recordId)
    return true
  }

  private aliasAdd(key: string, entityId: string, by: number): void {
    let entry = this.aliases.get(key)
    if (!entry) this.aliases.set(key, (entry = new Map()))
    addCount(entry, entityId, by)
    if (!entry.size) this.aliases.delete(key)
  }

  private apply(c: Contribution, sign: 1 | -1): void {
    this.fuzzyCache = null
    this.aliasFirstToken = null
    const set = sign === 1 ? setAdd : setRemove
    for (const key of c.aliasKeys) this.aliasAdd(key, c.entityId, sign)
    set(this.byKind, c.kind, c.entityId)
    if (c.areaKey && c.areaDisplay) {
      set(this.byArea, c.areaKey, c.entityId)
      if (sign === 1) registryAdd(this.areas, c.areaKey, c.recordId, c.areaDisplay)
      else registryRemove(this.areas, c.areaKey, c.recordId)
      this.aliasAdd(c.areaKey, AREA_PREFIX + c.areaKey, sign)
    }
    for (const item of c.sold) {
      if (sign === 1) registryAdd(this.products, item.productKey, c.recordId, item.display)
      else registryRemove(this.products, item.productKey, c.recordId)
      set(this.sellersByProduct, item.productKey, c.recordId)
      this.aliasAdd(item.productKey, PRODUCT_PREFIX + item.productKey, sign)
    }
    for (const item of c.speciesKeys) {
      if (sign === 1) registryAdd(this.species, item.key, c.recordId, item.display)
      else registryRemove(this.species, item.key, c.recordId)
      set(this.bySpecies, item.key, c.recordId)
      this.aliasAdd(item.key, SPECIES_PREFIX + item.key, sign)
    }
    for (const key of c.livesInKeys) set(this.livesIn, key, c.recordId)
    for (const key of c.appliesToKeys) set(this.appliesTo, key, c.recordId)
    for (const key of c.valueKeys) set(this.byValue, key, c.recordId)
    for (const [term, tf] of c.terms) {
      let entry = this.postings.get(term)
      if (!entry) this.postings.set(term, (entry = new Map()))
      if (sign === 1) entry.set(c.recordId, tf)
      else entry.delete(c.recordId)
      if (!entry.size) this.postings.delete(term)
    }
    this.totalLength += sign * c.length
  }

  entity(id: string): IndexedEntity | null {
    if (id.startsWith(RECORD_PREFIX)) {
      const c = this.contributions.get(id.slice(RECORD_PREFIX.length))
      return c ? { id, kind: c.kind, name: c.name, recordId: c.recordId, areaKey: c.areaKey } : null
    }
    const pick = (registry: Registry, prefix: string, kind: EntityKind): IndexedEntity | null => {
      const entry = registry.get(id.slice(prefix.length))
      if (!entry) return null
      const name = [...entry.values()].sort()[0] ?? id
      return {
        id,
        kind,
        name,
        recordId: null,
        areaKey: kind === 'area' ? id.slice(prefix.length) : null,
      }
    }
    if (id.startsWith(PRODUCT_PREFIX)) return pick(this.products, PRODUCT_PREFIX, 'product')
    if (id.startsWith(SPECIES_PREFIX)) return pick(this.species, SPECIES_PREFIX, 'species')
    if (id.startsWith(AREA_PREFIX)) return pick(this.areas, AREA_PREFIX, 'area')
    return null
  }

  /** Exact source identity aliases only; model aliases never establish identity. */
  resolveKey(key: string): string[] {
    return [...(this.aliases.get(key)?.keys() ?? [])].sort()
  }

  /** Neutral candidate bodies only: no proposal value enters a fact or governing index. */
  proposalRecordIds(question: string, limit = 6): string[] {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100)
      throw new Error('Invalid proposal limit')
    const query = ` ${phraseKey(question)} `
    const ids: string[] = []
    for (const [id, contribution] of [...this.contributions].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const cached = this.enrichmentByRecord.get(id)
      if (
        !cached ||
        cached.sourceFingerprint !== proposalSourceFingerprint(this.records.get(id)!) ||
        !Array.isArray(cached.targets) ||
        cached.targets.some((target) => {
          if (!target || typeof target.recordId !== 'string') return true
          const current = this.records.get(target.recordId)
          return !current || proposalSourceFingerprint(current) !== target.fingerprint
        })
      )
        continue
      const currentClaims = contribution.enrichment.filter((claim) => {
        const targetKey = claim.type === 'sells' ? phraseKey(claim.seller) : claim.targetKey
        const resolved = this.resolveKey(targetKey).filter((entityId) =>
          entityId.startsWith(RECORD_PREFIX),
        )
        if (claim.type !== 'sells' && resolved.length !== 1) return false
        return resolved.every((entityId) =>
          cached.targets!.some(
            (target) => target.recordId === entityId.slice(RECORD_PREFIX.length),
          ),
        )
      })
      const keys = currentClaims.flatMap((claim) =>
        claim.type === 'alias'
          ? [claim.alias, claim.targetKey]
          : claim.type === 'sells'
            ? [claim.productDisplay, claim.seller]
            : [claim.targetKey],
      )
      if (
        keys.some((key) => {
          const normalized = phraseKey(key)
          return normalized && query.includes(` ${normalized} `)
        })
      )
        ids.push(id)
      if (ids.length >= limit) break
    }
    return limit === 0 ? [] : ids
  }

  aliasKeysFor(entityId: string): string[] {
    if (entityId.startsWith(RECORD_PREFIX))
      return this.contributions.get(entityId.slice(RECORD_PREFIX.length))?.aliasKeys ?? []
    return [entityId.slice(entityId.indexOf(':') + 1)]
  }

  /** alias keys grouped by first token, for phrase matching. Rebuilt lazily after edits. */
  aliasesByFirstToken(): Map<string, Set<string>> {
    if (this.aliasFirstToken) return this.aliasFirstToken
    const map = new Map<string, Set<string>>()
    const keys = [...this.aliases.keys(), ...this.enrichmentAliases.keys()]
    for (const key of keys) setAdd(map, key.split(' ')[0] ?? '', key)
    this.aliasFirstToken = map
    return map
  }

  /** Vocabulary token -> alias tokens within one edit, for spelling variants ("dipping" -> "dippin"). */
  fuzzyVocabulary(): Map<string, Set<string>> {
    if (this.fuzzyCache) return this.fuzzyCache.vocabulary
    const vocabulary = new Map<string, Set<string>>()
    for (const key of [...this.aliases.keys(), ...this.enrichmentAliases.keys()])
      for (const token of key.split(' ')) {
        if (token.length < 5 || /\d/u.test(token)) continue
        setAdd(vocabulary, token, token)
        for (const variant of singleDeletions(token)) setAdd(vocabulary, variant, token)
      }
    this.fuzzyCache = { vocabulary }
    return vocabulary
  }

  /** BM25 over record passages (record kind, area, title and body). */
  search(
    query: string,
    options: { limit: number; filter?: (recordId: string) => boolean },
  ): Array<{ recordId: string; score: number }> {
    const terms = [...new Set(stemTokens(query).filter((token) => !isStopword(token)))]
    const n = this.contributions.size || 1
    const average = this.totalLength / n || 1
    const scores = new Map<string, number>()
    for (const term of terms) {
      const entry = this.postings.get(term)
      if (!entry) continue
      const idf = Math.log(1 + (n - entry.size + 0.5) / (entry.size + 0.5))
      for (const [recordId, tf] of entry) {
        if (options.filter && !options.filter(recordId)) continue
        const length = this.contributions.get(recordId)?.length ?? average
        const score = (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * length) / average))
        scores.set(recordId, (scores.get(recordId) ?? 0) + score)
      }
    }
    return [...scores.entries()]
      .map(([recordId, score]) => ({ recordId, score }))
      .sort((a, b) => b.score - a.score || a.recordId.localeCompare(b.recordId))
      .slice(0, options.limit)
  }

  /** Records whose text contains the alias phrase (all tokens, then exact phrase). */
  recordsMentioning(aliasKey: string, limit = 50): string[] {
    const tokens = aliasKey.split(' ').filter((token) => !isStopword(token))
    if (!tokens.length) return []
    const lists = tokens.map((token) => this.postings.get(token))
    if (lists.some((list) => !list)) return []
    const smallest = [...lists].sort((a, b) => (a?.size ?? 0) - (b?.size ?? 0))[0]!
    const hits: string[] = []
    for (const recordId of [...smallest.keys()].sort()) {
      if (!lists.every((list) => list?.has(recordId))) continue
      const record = this.records.get(recordId)
      if (!record) continue
      const text = ` ${stemTokens(`${record.title} ${record.body}`).join(' ')} `
      if (text.includes(` ${aliasKey} `)) hits.push(recordId)
      if (hits.length >= limit) break
    }
    return hits
  }

  /** Canonical dump of every derived structure, for proving incremental == full rebuild. */
  canonical(): string {
    const sortMap = (map: Map<string, unknown>): Array<[string, unknown]> =>
      [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, normalizeValue(value)])
    const normalizeValue = (value: unknown): unknown => {
      if (value instanceof Map) return sortMap(value as Map<string, unknown>)
      if (value instanceof Set) return [...(value as Set<string>)].sort()
      return value
    }
    return JSON.stringify({
      records: sortMap(this.records),
      contributions: sortMap(
        new Map(
          [...this.contributions].map(([key, c]) => [key, { ...c, terms: sortMap(c.terms) }]),
        ),
      ),
      aliases: sortMap(this.aliases),
      products: sortMap(this.products),
      species: sortMap(this.species),
      areas: sortMap(this.areas),
      byKind: sortMap(this.byKind),
      byArea: sortMap(this.byArea),
      byValue: sortMap(this.byValue),
      sellersByProduct: sortMap(this.sellersByProduct),
      bySpecies: sortMap(this.bySpecies),
      livesIn: sortMap(this.livesIn),
      appliesTo: sortMap(this.appliesTo),
      enrichmentSellers: sortMap(this.enrichmentSellers),
      enrichmentFacts: sortMap(this.enrichmentFacts),
      enrichmentAliases: sortMap(this.enrichmentAliases),
      postings: sortMap(this.postings),
      totalLength: this.totalLength,
    })
  }
}

/** Setup report: problems an operator should see before the index is trusted. */
export function validateVenueIndex(index: VenueIndex): {
  unresolvedReferences: Array<{ recordId: string; label: string; target: string }>
  duplicateNames: Array<{ name: string; recordIds: string[] }>
  staleEnrichment: string[]
  conflicts: Array<{
    entity: string
    field: string
    values: Array<{ value: string; recordId: string }>
  }>
} {
  const unresolvedReferences: Array<{ recordId: string; label: string; target: string }> = []
  for (const c of index.contributions.values()) {
    for (const [label, keys] of [
      ['lives in', c.livesInKeys],
      ['applies to', c.appliesToKeys],
    ] as const)
      for (const key of keys)
        if (!index.resolveKey(key).length)
          unresolvedReferences.push({ recordId: c.recordId, label, target: key })
  }
  const duplicateNames: Array<{ name: string; recordIds: string[] }> = []
  for (const [key, entities] of index.aliases) {
    const records = [...entities.keys()].filter((id) => id.startsWith(RECORD_PREFIX))
    if (records.length > 1)
      duplicateNames.push({
        name: key,
        recordIds: records.map((id) => id.slice(RECORD_PREFIX.length)).sort(),
      })
  }
  const staleEnrichment = [...index.contributions.values()]
    .filter((c) => {
      const enrichment = index.enrichmentFor(c.recordId)
      return (
        enrichment !== undefined &&
        (enrichment.bodySha256 !== c.bodySha256 ||
          enrichment.sourceFingerprint !==
            proposalSourceFingerprint(index.records.get(c.recordId)!))
      )
    })
    .map((c) => c.recordId)
  return { unresolvedReferences, duplicateNames, staleEnrichment, conflicts: findConflicts(index) }
}

const FIELD_LABELS: Record<string, string> = {
  height: 'height',
  ages: 'ages',
  price: 'price',
  hours: 'hours',
  time: 'when',
  when: 'when',
}

/** A record's own labeled field versus a validated claim about the same entity in another record. */
export function findConflicts(
  index: VenueIndex,
  onlyKeys?: Set<string>,
): Array<{ entity: string; field: string; values: Array<{ value: string; recordId: string }> }> {
  const out: Array<{
    entity: string
    field: string
    values: Array<{ value: string; recordId: string }>
  }> = []
  for (const [targetKey, recordIds] of index.enrichmentFacts) {
    if (onlyKeys && !onlyKeys.has(targetKey)) continue
    for (const owner of index.resolveKey(targetKey)) {
      const own = index.contributions.get(owner.slice(RECORD_PREFIX.length))
      if (!own) continue
      for (const recordId of recordIds) {
        for (const claim of index.contributions.get(recordId)?.enrichment ?? []) {
          if (claim.type !== 'fact' || claim.targetKey !== targetKey) continue
          const field = FIELD_LABELS[claim.field.toLowerCase()] ?? claim.field.toLowerCase()
          const mine = own.labels.find((label) => label.label === field)
          if (mine && numbersOf(mine.value) !== numbersOf(claim.value))
            out.push({
              entity: own.name,
              field,
              values: [
                { value: mine.value, recordId: own.recordId },
                { value: claim.value, recordId },
              ],
            })
        }
      }
    }
  }
  return out
}

function numbersOf(value: string): string {
  return (value.match(/\d+(?:[.:]\d+)?/gu) ?? []).join(',') || normalizeText(value)
}

export { stem }
