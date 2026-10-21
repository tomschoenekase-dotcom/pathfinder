import { createHash } from 'node:crypto'

/** Evidence is supplied by the current-source adapter; this module never infers authority. */
export type GuestQueryEvidence =
  | { sourceKey: string; start: number; end: number; fieldPath?: never }
  | { sourceKey: string; fieldPath: string; start?: never; end?: never }

export type GuestQueryFact<T> =
  | { state: 'KNOWN'; value: T; sources: readonly GuestQueryEvidence[] }
  | { state: 'UNKNOWN' }
  | { state: 'CONFLICTING'; values: readonly T[]; sources: readonly GuestQueryEvidence[] }

export type GuestQueryProducts =
  | { state: 'UNKNOWN' }
  | { state: 'CONFLICTING'; sources: readonly GuestQueryEvidence[] }
  | {
      state: 'KNOWN'
      completeness: 'COMPLETE' | 'POSITIVE_ONLY'
      sources: readonly GuestQueryEvidence[]
      offers: readonly { name: string; sources: readonly GuestQueryEvidence[] }[]
    }

export type GuestQueryDomain = 'ALL' | 'PLACE' | 'KNOWLEDGE'
export const GUEST_QUERY_DOMAIN_CONTRACT = 'guest-query-domain-v1' as const

export interface GuestStructuredRecord {
  key: string
  tenantId: string
  venueId: string
  name: string
  /** Trusted adapter origin; omitted preserves historical ALL-only records. */
  entityDomain?: Exclude<GuestQueryDomain, 'ALL'>
  aliases?: readonly string[]
  kind?: GuestQueryFact<string>
  area?: GuestQueryFact<string>
  products?: GuestQueryProducts
  features?: Readonly<Record<string, GuestQueryFact<boolean>>>
}

export interface GuestStructuredSnapshot {
  tenantId: string
  venueId: string
  version: string
  asOf: string
  coverage: 'COMPLETE' | 'PARTIAL'
  records: readonly GuestStructuredRecord[]
  /** Explicit current authority set; when absent only record keys may support facts. */
  evidenceKeys?: readonly string[]
}

export type GuestStructuredPredicate =
  | { field: 'key'; equals: string }
  | { field: 'name'; equals: string }
  | { field: 'kind'; equals: string }
  | { field: 'area'; equals: string }
  | { field: 'product'; name: string }
  | { field: 'feature'; name: string; value: boolean }

export interface GuestStructuredQuery {
  tenantId: string
  venueId: string
  mode: 'count' | 'list'
  domain?: GuestQueryDomain
  predicates: readonly GuestStructuredPredicate[]
}

export interface GuestStructuredQueryPage {
  pageSize?: number
  cursor?: string
}

export interface GuestStructuredQueryResult {
  mode: GuestStructuredQuery['mode']
  domain: GuestQueryDomain
  candidateCount: number
  domainContract: typeof GUEST_QUERY_DOMAIN_CONTRACT
  tenantId: string
  venueId: string
  sourceVersion: string
  asOf: string
  coverage: 'COMPLETE' | 'PARTIAL'
  queryIdentity: string
  knownMatchCount: number
  unknownCandidateCount: number
  matchingKeys: string[]
  unknownKeys: string[]
  rows: GuestStructuredRecord[]
  returnedCount: number
  hasMore: boolean
  nextCursor: string | null
  exhaustiveAnswerEligible: boolean
  /** Null unless stored-record coverage is complete and every candidate is decided. */
  exactEligibleCount: number | null
  inventoryScope: 'STORED_RECORDS_ONLY'
}

export class GuestStructuredQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuestStructuredQueryError'
  }
}

type ObjectValue = Record<string, unknown>
type Truth = 'TRUE' | 'FALSE' | 'UNKNOWN'
const MAX_PAGE_SIZE = 200
const MAX_PREDICATES = 32
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

function fail(message: string): never {
  throw new GuestStructuredQueryError(message)
}

function object(value: unknown, at: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${at}: expected object`)
  return value as ObjectValue
}

function fields(value: ObjectValue, allowed: readonly string[], at: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${at}: unexpected field`)
}

function string(value: unknown, at: string, max = 2048): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    fail(`${at}: expected nonempty bounded text`)
  }
}

function key(value: unknown, at: string): asserts value is string {
  string(value, at, 512)
  if (!/^[A-Za-z0-9_-]+:[^\s:][^\s]*$/u.test(value)) fail(`${at}: expected namespaced key`)
}

function integer(value: unknown, at: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    fail(`${at}: invalid integer bound`)
}

function evidence(value: unknown, at: string) {
  if (!Array.isArray(value) || value.length === 0) fail(`${at}: expected nonempty source array`)
  for (const [i, source] of value.entries()) {
    const s = object(source, `${at}[${i}]`)
    key(s.sourceKey, `${at}.sourceKey`)
    if (own(s, 'fieldPath')) {
      fields(s, ['sourceKey', 'fieldPath'], at)
      string(s.fieldPath, `${at}.fieldPath`, 512)
      if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/u.test(s.fieldPath))
        fail(`${at}: unsafe fieldPath`)
      if (
        s.fieldPath
          .split(/\.|\[|\]/u)
          .some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))
      )
        fail(`${at}: unsafe fieldPath`)
    } else {
      fields(s, ['sourceKey', 'start', 'end'], at)
      integer(s.start, `${at}.start`, 0, Number.MAX_SAFE_INTEGER)
      integer(s.end, `${at}.end`, 1, Number.MAX_SAFE_INTEGER)
      if (s.end <= s.start) fail(`${at}: empty/reversed source span`)
    }
  }
}

function fact(value: unknown, kind: 'string' | 'boolean', at: string) {
  if (value === undefined) return
  const f = object(value, at)
  const check = (v: unknown) => {
    if (kind === 'string') string(v, `${at}.value`)
    else if (typeof v !== 'boolean') fail(`${at}: expected boolean value`)
  }
  if (f.state === 'UNKNOWN') fields(f, ['state'], at)
  else if (f.state === 'KNOWN') {
    fields(f, ['state', 'value', 'sources'], at)
    check(f.value)
    evidence(f.sources, `${at}.sources`)
  } else if (f.state === 'CONFLICTING') {
    fields(f, ['state', 'values', 'sources'], at)
    if (!Array.isArray(f.values) || f.values.length < 2)
      fail(`${at}: conflicting fact needs multiple values`)
    f.values.forEach(check)
    evidence(f.sources, `${at}.sources`)
  } else fail(`${at}: invalid fact state`)
}

function products(value: unknown, at: string) {
  if (value === undefined) return
  const p = object(value, at)
  if (p.state === 'UNKNOWN') fields(p, ['state'], at)
  else if (p.state === 'CONFLICTING') {
    fields(p, ['state', 'sources'], at)
    evidence(p.sources, at)
  } else if (p.state === 'KNOWN') {
    fields(p, ['state', 'completeness', 'sources', 'offers'], at)
    if (!['COMPLETE', 'POSITIVE_ONLY'].includes(p.completeness as string))
      fail(`${at}: invalid product completeness`)
    evidence(p.sources, `${at}.sources`)
    if (!Array.isArray(p.offers)) fail(`${at}: expected offers`)
    for (const value of p.offers) {
      const offer = object(value, `${at}.offer`)
      fields(offer, ['name', 'sources'], at)
      string(offer.name, `${at}.offer.name`)
      evidence(offer.sources, `${at}.offer.sources`)
    }
  } else fail(`${at}: invalid product state`)
}

/** Exact identity matching only; punctuation equivalence never becomes substring matching. */
export function normalizeGuestQueryText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/[‐‑‒–—−]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

function validTimestamp(value: string): boolean {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.exec(
      value,
    )
  if (!parts || !Number.isFinite(Date.parse(value))) return false
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    Number(parts[4]) <= 23 &&
    Number(parts[5]) <= 59 &&
    Number(parts[6]) <= 59
  )
}

function validateSnapshot(snapshot: unknown) {
  const s = object(snapshot, 'snapshot')
  fields(
    s,
    ['tenantId', 'venueId', 'version', 'asOf', 'coverage', 'records', 'evidenceKeys'],
    'snapshot',
  )
  for (const f of ['tenantId', 'venueId', 'version']) string(s[f], `snapshot.${f}`, 512)
  string(s.asOf, 'snapshot.asOf', 64)
  if (!validTimestamp(s.asOf)) fail('snapshot: invalid asOf timestamp')
  if (!['COMPLETE', 'PARTIAL'].includes(s.coverage as string)) fail('snapshot: invalid coverage')
  if (!Array.isArray(s.records)) fail('snapshot: expected records')
  if (s.evidenceKeys !== undefined) {
    if (!Array.isArray(s.evidenceKeys)) fail('snapshot: expected evidence keys')
    const evidenceKeys = new Set<string>()
    for (const value of s.evidenceKeys) {
      key(value, 'snapshot.evidenceKeys')
      if (evidenceKeys.has(value)) fail('snapshot: duplicate evidence key')
      evidenceKeys.add(value)
    }
  }
  const keys = new Set<string>()
  for (const value of s.records) {
    const r = object(value, 'record')
    fields(
      r,
      [
        'key',
        'tenantId',
        'venueId',
        'name',
        'entityDomain',
        'aliases',
        'kind',
        'area',
        'products',
        'features',
      ],
      'record',
    )
    key(r.key, 'record.key')
    if (keys.has(r.key)) fail('snapshot: duplicate record key')
    keys.add(r.key)
    if (r.tenantId !== s.tenantId || r.venueId !== s.venueId) fail('record: scope mismatch')
    string(r.name, 'record.name')
    if (r.entityDomain !== undefined && !['PLACE', 'KNOWLEDGE'].includes(r.entityDomain as string))
      fail('record: invalid entity domain')
    if (r.aliases !== undefined) {
      if (!Array.isArray(r.aliases)) fail('record: expected aliases')
      r.aliases.forEach((alias) => string(alias, 'record.alias'))
    }
    fact(r.kind, 'string', 'record.kind')
    fact(r.area, 'string', 'record.area')
    products(r.products, 'record.products')
    if (r.features !== undefined) {
      const fs = object(r.features, 'record.features')
      const normalized = new Set<string>()
      for (const [name, value] of Object.entries(fs)) {
        string(name, 'record.feature.name', 128)
        const n = normalizeGuestQueryText(name)
        if (normalized.has(n)) fail('record: duplicate normalized feature name')
        normalized.add(n)
        fact(value, 'boolean', 'record.feature')
      }
    }
  }
}

function validateQuery(scope: { tenantId: string; venueId: string }, query: unknown) {
  const q = object(query, 'query')
  fields(q, ['tenantId', 'venueId', 'mode', 'domain', 'predicates'], 'query')
  if (q.tenantId !== scope.tenantId || q.venueId !== scope.venueId) fail('query: scope mismatch')
  if (!['count', 'list'].includes(q.mode as string)) fail('query: invalid mode')
  if (q.domain !== undefined && !['ALL', 'PLACE', 'KNOWLEDGE'].includes(q.domain as string))
    fail('query: invalid domain')
  if (!Array.isArray(q.predicates) || q.predicates.length > MAX_PREDICATES)
    fail('query: invalid predicate count')
  for (const value of q.predicates) {
    const p = object(value, 'predicate')
    if (p.field === 'key') {
      fields(p, ['field', 'equals'], 'predicate')
      key(p.equals, 'predicate.equals')
    } else if (['name', 'kind', 'area'].includes(p.field as string)) {
      fields(p, ['field', 'equals'], 'predicate')
      string(p.equals, 'predicate.equals')
    } else if (p.field === 'product') {
      if (q.domain === 'KNOWLEDGE') fail('query: product seller domain cannot be KNOWLEDGE')
      fields(p, ['field', 'name'], 'predicate')
      string(p.name, 'predicate.name')
    } else if (p.field === 'feature') {
      fields(p, ['field', 'name', 'value'], 'predicate')
      string(p.name, 'predicate.name', 128)
      if (typeof p.value !== 'boolean') fail('predicate: expected boolean value')
    } else fail('predicate: unsupported field')
  }
}

function validatePage(page: unknown) {
  const options = object(page, 'page')
  fields(options, ['pageSize', 'cursor'], 'page')
  if (options.pageSize !== undefined) integer(options.pageSize, 'page.pageSize', 1, MAX_PAGE_SIZE)
  if (options.cursor !== undefined) string(options.cursor, 'page.cursor', 4096)
}

function supported(sources: readonly GuestQueryEvidence[], keys: ReadonlySet<string>): boolean {
  return sources.length > 0 && sources.every((source) => keys.has(source.sourceKey))
}

function compare<T>(
  fact: GuestQueryFact<T> | undefined,
  wanted: T,
  keys: ReadonlySet<string>,
): Truth {
  if (!fact || fact.state !== 'KNOWN' || !supported(fact.sources, keys)) return 'UNKNOWN'
  const equals =
    typeof fact.value === 'string' && typeof wanted === 'string'
      ? normalizeGuestQueryText(fact.value) === normalizeGuestQueryText(wanted)
      : fact.value === wanted
  return equals ? 'TRUE' : 'FALSE'
}

function test(
  record: GuestStructuredRecord,
  predicate: GuestStructuredPredicate,
  keys: ReadonlySet<string>,
): Truth {
  if (predicate.field === 'key') return record.key === predicate.equals ? 'TRUE' : 'FALSE'
  if (predicate.field === 'name')
    return [record.name, ...(record.aliases ?? [])].some(
      (name) => normalizeGuestQueryText(name) === normalizeGuestQueryText(predicate.equals),
    )
      ? 'TRUE'
      : 'FALSE'
  if (predicate.field === 'kind') return compare(record.kind, predicate.equals, keys)
  if (predicate.field === 'area') return compare(record.area, predicate.equals, keys)
  if (predicate.field === 'feature') {
    const feature = Object.entries(record.features ?? {}).find(
      ([name]) => normalizeGuestQueryText(name) === normalizeGuestQueryText(predicate.name),
    )?.[1]
    return compare(feature, predicate.value, keys)
  }
  if (!record.products || record.products.state !== 'KNOWN') return 'UNKNOWN'
  const p = record.products
  const offers = p.offers.filter(
    (offer) => normalizeGuestQueryText(offer.name) === normalizeGuestQueryText(predicate.name),
  )
  if (offers.some((offer) => supported(offer.sources, keys))) return 'TRUE'
  // An unsupported observation cannot prove either presence or absence, even in a declared complete set.
  if (offers.length || p.offers.some((offer) => !supported(offer.sources, keys))) return 'UNKNOWN'
  return p.completeness === 'COMPLETE' && supported(p.sources, keys) ? 'FALSE' : 'UNKNOWN'
}

export interface PreparedGuestPlanningVocabulary {
  kinds: readonly string[]
  areas: readonly string[]
  features: readonly string[]
}

export const GUEST_NAMED_CATALOG_CONTRACT = 'guest-named-catalog-v1' as const
export const MAX_NAMED_INDEX_CHARS = 2_000_000
export const MAX_NAMED_INDEX_ENTRIES = 100_000
export const MAX_NAMED_INDEX_NODES = 250_000
export const MAX_NAMED_DISCOVERY_STEPS = 2_000_000
export const MAX_NAMED_DISCOVERY_HITS = 64
export const MAX_NAMED_CATALOG_GROUPS = 8
export const MAX_NAMED_CATALOG_CHARS = 4000

export interface GuestNamedCatalogGroup {
  ref: string
  normalizedMention: string
  normalizedSpans: Array<{ start: number; end: number }>
  candidateCount: number
  /** Absent for ambiguous groups: never select an arbitrary duplicate identity. */
  record?: { key: string; name: string; domain?: Exclude<GuestQueryDomain, 'ALL'>; kind?: string; area?: string }
}
export interface GuestNamedCatalogData {
  contract: typeof GUEST_NAMED_CATALOG_CONTRACT
  sourceVersion: string
  snapshotIdentity: string
  questionSha256: string
  catalogIdentity: string
  coordinates: 'NORMALIZED_UNICODE_CODEPOINTS'
  status: 'READY' | 'BOUNDED'
  reason: string | null
  groups: GuestNamedCatalogGroup[]
}
/** An opaque, prepared-instance-owned catalog. A deserialized lookalike has no authority. */
export interface GuestNamedCandidateCatalog {
  readonly data: GuestNamedCatalogData
}
const namedQuestionHash = (question: string) => createHash('sha256').update(question).digest('hex')

class NamedCatalog implements GuestNamedCandidateCatalog {
  #owner: object
  #data: GuestNamedCatalogData
  constructor(owner: object, data: GuestNamedCatalogData) {
    this.#owner = owner
    this.#data = data
    Object.freeze(this)
  }
  get data() { return structuredClone(this.#data) }
  static owned(value: unknown, owner: object, question: string): NamedCatalog {
    if (!value || typeof value !== 'object' || !(#owner in value) ||
      value.#owner !== owner || value.#data.questionSha256 !== namedQuestionHash(question))
      fail('name catalog: source or question binding mismatch')
    return value
  }
}
type NameNode = { children: Map<string, NameNode>; terminal?: { name: string; keys: Set<string> } }
type NameIndex = { root: NameNode } | { reason: string }

/** One immutable admitted-turn snapshot, not a cache or a source-authority grant. */
export interface PreparedGuestSnapshot {
  readonly scope: Readonly<{ tenantId: string; venueId: string }>
  readonly sourceVersion: string
  readonly asOf: string
  readonly coverage: GuestStructuredSnapshot['coverage']
  readonly snapshotIdentity: string
  planningVocabulary(): PreparedGuestPlanningVocabulary
  discoverNamedCandidates(question: string): GuestNamedCandidateCatalog
  namedCatalogData(catalog: GuestNamedCandidateCatalog, question: string): GuestNamedCatalogData
  resolveNamedReference(catalog: GuestNamedCandidateCatalog, question: string, ref: string): string
  validateNamedValue(catalog: GuestNamedCandidateCatalog, question: string, value: string): string
  validateQuery(raw: unknown): GuestStructuredQuery
  evaluate(rawQuery: unknown): PreparedGuestQuery
}

export interface PreparedGuestQuery {
  readonly queryIdentity: string
  page(options?: GuestStructuredQueryPage): GuestStructuredQueryResult
}

// No registry/cache: the private brand and unexported construction token establish runtime identity.
const PREPARED_TOKEN = Symbol('private guest query construction')
type CursorBinding = {
  tenantId: string
  venueId: string
  sourceVersion: string
  snapshotIdentity: string
  queryIdentity: string
}

class PreparedSnapshot implements PreparedGuestSnapshot {
  #snapshot: GuestStructuredSnapshot
  #records: readonly GuestStructuredRecord[]
  #keys: ReadonlySet<string>
  #identity: string
  #vocabulary: PreparedGuestPlanningVocabulary
  #recordsByKey: ReadonlyMap<string, GuestStructuredRecord>
  #hasUntrustedDomain: boolean
  #nameOwner = Object.freeze({})
  #nameIndex: NameIndex | undefined

  constructor(token: symbol, snapshot: GuestStructuredSnapshot) {
    if (token !== PREPARED_TOKEN) fail('Invalid prepared snapshot construction')
    this.#snapshot = snapshot
    this.#records = [...snapshot.records].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    )
    this.#keys = new Set(snapshot.evidenceKeys ?? this.#records.map((record) => record.key))
    this.#recordsByKey = new Map(this.#records.map(record => [record.key, record]))
    this.#hasUntrustedDomain = this.#records.some(record => record.entityDomain === undefined)
    // Preserve format-1 cursor identity exactly; observation time remains excluded.
    this.#identity = hash({
      tenantId: snapshot.tenantId,
      venueId: snapshot.venueId,
      version: snapshot.version,
      coverage: snapshot.coverage,
      records: this.#records,
      evidenceKeys:
        snapshot.evidenceKeys === undefined ? undefined : [...snapshot.evidenceKeys].sort(),
    })
    const kinds = new Set<string>(),
      areas = new Set<string>(),
      features = new Set<string>()
    for (const record of this.#records) {
      if (record.kind?.state === 'KNOWN') kinds.add(record.kind.value)
      if (record.area?.state === 'KNOWN') areas.add(record.area.value)
      for (const name of Object.keys(record.features ?? {})) features.add(name)
    }
    this.#vocabulary = {
      kinds: [...kinds].sort(),
      areas: [...areas].sort(),
      features: [...features].sort(),
    }
    Object.freeze(this)
  }

  static is(value: unknown): value is PreparedSnapshot {
    return value !== null && typeof value === 'object' && #snapshot in value
  }
  get scope() {
    return { tenantId: this.#snapshot.tenantId, venueId: this.#snapshot.venueId }
  }
  get sourceVersion() {
    return this.#snapshot.version
  }
  get asOf() {
    return this.#snapshot.asOf
  }
  get coverage() {
    return this.#snapshot.coverage
  }
  get snapshotIdentity() {
    return this.#identity
  }
  planningVocabulary(): PreparedGuestPlanningVocabulary {
    return structuredClone(this.#vocabulary)
  }

  #buildNameIndex(): NameIndex {
    const root: NameNode = { children: new Map() }
    let rawChars = 0, normalizedChars = 0, entries = 0, nodes = 1
    const add = (value: string, recordKey: string): boolean => {
      // Check before normalization or spreading an arbitrarily large alias array.
      if (++entries > MAX_NAMED_INDEX_ENTRIES || (rawChars += value.length) > MAX_NAMED_INDEX_CHARS) return false
      const name = normalizeGuestQueryText(value)
      if ((normalizedChars += name.length) > MAX_NAMED_INDEX_CHARS) return false
      let node = root
      for (const character of name) {
        let child = node.children.get(character)
        if (!child) {
          if (++nodes > MAX_NAMED_INDEX_NODES) return false
          node.children.set(character, child = { children: new Map() })
        }
        node = child
      }
      node.terminal ??= { name, keys: new Set() }
      node.terminal.keys.add(recordKey)
      return true
    }
    for (const record of this.#records) {
      if (!add(record.name, record.key)) return { reason: 'NAME_INDEX_BOUND' }
      for (const alias of record.aliases ?? []) if (!add(alias, record.key)) return { reason: 'NAME_INDEX_BOUND' }
    }
    return { root }
  }

  discoverNamedCandidates(question: string): GuestNamedCandidateCatalog {
    if (typeof question !== 'string' || !question.trim() || question.length > 16_000) fail('name catalog: invalid question')
    const finish = (groups: GuestNamedCatalogGroup[], reason: string | null = null) => {
      const body = { contract: GUEST_NAMED_CATALOG_CONTRACT, sourceVersion: this.sourceVersion,
        snapshotIdentity: this.snapshotIdentity, questionSha256: namedQuestionHash(question),
        coordinates: 'NORMALIZED_UNICODE_CODEPOINTS' as const,
        status: reason ? 'BOUNDED' as const : 'READY' as const, reason, groups }
      return new NamedCatalog(this.#nameOwner, { ...body, catalogIdentity: hash(body) })
    }
    this.#nameIndex ??= this.#buildNameIndex()
    if ('reason' in this.#nameIndex) return finish([], this.#nameIndex.reason)
    const normalized = normalizeGuestQueryText(question)
    if (normalized.length > 32_000) return finish([], 'QUESTION_NORMALIZATION_BOUND')
    const characters = [...normalized]
    const word = (character: string | undefined) => character !== undefined && /[\p{L}\p{N}\p{M}_]/u.test(character)
    const hits: Array<{ start: number; end: number; terminal: NonNullable<NameNode['terminal']> }> = []
    let steps = 0
    for (let start = 0; start < characters.length; start++) {
      if (word(characters[start - 1])) continue
      let node: NameNode | undefined = this.#nameIndex.root
      for (let end = start; end < characters.length; end++) {
        if (++steps > MAX_NAMED_DISCOVERY_STEPS) return finish([], 'NAME_DISCOVERY_WORK_BOUND')
        node = node.children.get(characters[end]!)
        if (!node) break
        if (node.terminal && !word(characters[end + 1])) {
          if (hits.length >= MAX_NAMED_DISCOVERY_HITS) return finish([], 'NAME_DISCOVERY_HIT_BOUND')
          hits.push({ start, end: end + 1, terminal: node.terminal })
        }
      }
    }
    const maximal = hits.filter(a => !hits.some(b => b.start <= a.start && b.end >= a.end && (b.start < a.start || b.end > a.end)))
    if (maximal.some((a, i) => maximal.some((b, j) => i !== j && a.start < b.end && b.start < a.end))) return finish([], 'OVERLAPPING_NAMES')
    const groups: GuestNamedCatalogGroup[] = []
    for (const hit of maximal) {
      let group = groups.find(group => group.normalizedMention === hit.terminal.name)
      if (!group) {
        if (groups.length === MAX_NAMED_CATALOG_GROUPS) return finish([], 'NAME_CATALOG_BOUND')
        const unique = hit.terminal.keys.size === 1 ? this.#recordsByKey.get(hit.terminal.keys.values().next().value!) : undefined
        group = { ref: `n${groups.length}`, normalizedMention: hit.terminal.name, normalizedSpans: [], candidateCount: hit.terminal.keys.size,
          ...(unique ? { record: { key: unique.key, name: unique.name, ...(unique.entityDomain ? { domain: unique.entityDomain } : {}),
            ...(unique.kind?.state === 'KNOWN' && supported(unique.kind.sources, this.#keys) ? { kind: unique.kind.value } : {}),
            ...(unique.area?.state === 'KNOWN' && supported(unique.area.sources, this.#keys) ? { area: unique.area.value } : {}) } } : {}) }
        groups.push(group)
      }
      if (group.normalizedSpans.length === 8) return finish([], 'NAME_CATALOG_BOUND')
      group.normalizedSpans.push({ start: hit.start, end: hit.end })
    }
    if (JSON.stringify(groups).length > MAX_NAMED_CATALOG_CHARS) return finish([], 'NAME_CATALOG_BOUND')
    return finish(groups)
  }

  namedCatalogData(catalog: GuestNamedCandidateCatalog, question: string): GuestNamedCatalogData {
    return NamedCatalog.owned(catalog, this.#nameOwner, question).data
  }
  resolveNamedReference(catalog: GuestNamedCandidateCatalog, question: string, ref: string): string {
    const data = this.namedCatalogData(catalog, question)
    const group = data.groups.find(group => group.ref === ref)
    if (data.status !== 'READY' || !group?.record || group.candidateCount !== 1) fail('name catalog: unresolved or ambiguous reference')
    return group.record.key
  }
  validateNamedValue(catalog: GuestNamedCandidateCatalog, question: string, value: string): string {
    const data = this.namedCatalogData(catalog, question), normalized = normalizeGuestQueryText(value)
    const groups = data.groups.filter(group => group.normalizedMention === normalized || (group.record && normalizeGuestQueryText(group.record.name) === normalized))
    if (data.status !== 'READY' || groups.length === 0 || groups.some(group => !group.record || group.candidateCount !== 1) || new Set(groups.map(group => group.record!.key)).size !== 1)
      fail('name catalog: unresolved or ambiguous full name')
    return groups[0]!.record!.key
  }

  validateQuery(raw: unknown): GuestStructuredQuery {
    const query = structuredClone(raw)
    validateQuery(this.scope, query)
    const domain = (query as GuestStructuredQuery).domain ?? 'ALL'
    if (domain !== 'ALL' && this.#hasUntrustedDomain)
      fail('query: explicit domain requires trusted record domains')
    for (const predicate of (query as GuestStructuredQuery).predicates)
      if (predicate.field === 'key' && !this.#recordsByKey.has(predicate.equals)) fail('query: key is not a current scoped record')
    return query as GuestStructuredQuery
  }

  evaluate(rawQuery: unknown): PreparedGuestQuery {
    const query = this.validateQuery(rawQuery)
    const matches: GuestStructuredRecord[] = [],
      unknownKeys: string[] = []
    const domain = query.domain ?? 'ALL'
    const candidates =
      domain === 'ALL'
        ? this.#records
        : this.#records.filter((record) => record.entityDomain === domain)
    for (const record of candidates) {
      const values = query.predicates.map((predicate) => test(record, predicate, this.#keys))
      if (values.includes('FALSE')) continue
      if (values.includes('UNKNOWN')) unknownKeys.push(record.key)
      else matches.push(record)
    }
    return new EvaluatedQuery(
      PREPARED_TOKEN,
      this.#snapshot,
      query.mode,
      domain,
      candidates.length,
      {
        ...this.scope,
        sourceVersion: this.sourceVersion,
        snapshotIdentity: this.snapshotIdentity,
        queryIdentity: hash(query),
      },
      matches,
      unknownKeys,
    )
  }
}

class EvaluatedQuery implements PreparedGuestQuery {
  #mode: GuestStructuredQuery['mode']
  #domain: GuestQueryDomain
  #candidateCount: number
  #snapshot: GuestStructuredSnapshot
  #binding: CursorBinding
  #matches: readonly GuestStructuredRecord[]
  #matchingKeys: readonly string[]
  #unknownKeys: readonly string[]
  #positions: ReadonlyMap<string, number>

  constructor(
    token: symbol,
    snapshot: GuestStructuredSnapshot,
    mode: GuestStructuredQuery['mode'],
    domain: GuestQueryDomain,
    candidateCount: number,
    binding: CursorBinding,
    matches: GuestStructuredRecord[],
    unknownKeys: string[],
  ) {
    if (token !== PREPARED_TOKEN) fail('Invalid prepared query construction')
    this.#snapshot = snapshot
    this.#mode = mode
    this.#domain = domain
    this.#candidateCount = candidateCount
    this.#binding = binding
    this.#matches = matches
    this.#matchingKeys = matches.map((record) => record.key)
    this.#unknownKeys = unknownKeys
    this.#positions = new Map(matches.map((record, index) => [record.key, index + 1]))
    Object.freeze(this)
  }
  get queryIdentity() {
    return this.#binding.queryIdentity
  }

  page(options: GuestStructuredQueryPage = {}): GuestStructuredQueryResult {
    validatePage(options)
    if (this.#mode === 'count' && (options.cursor !== undefined || options.pageSize !== undefined))
      fail('page: count mode does not support paging; query changed')
    let after: string | undefined
    if (options.cursor !== undefined) {
      let cursor: ObjectValue
      try {
        if (!/^[A-Za-z0-9_-]+$/u.test(options.cursor)) fail('cursor: invalid encoding')
        cursor = object(
          JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')),
          'cursor',
        )
      } catch {
        fail('cursor: invalid encoding or payload')
      }
      fields(cursor, ['format', ...Object.keys(this.#binding), 'lastKey'], 'cursor')
      if (
        cursor.format !== 1 ||
        Object.entries(this.#binding).some(([key, value]) => cursor[key] !== value)
      )
        fail('cursor: snapshot, scope or query changed')
      key(cursor.lastKey, 'cursor.lastKey')
      after = cursor.lastKey
    }
    const start = after === undefined ? 0 : this.#positions.get(after)
    if (start === undefined) fail('cursor: continuation key is not a known match')
    const rows =
      this.#mode === 'count' ? [] : this.#matches.slice(start, start + (options.pageSize ?? 50))
    const hasMore = this.#mode === 'list' && start + rows.length < this.#matches.length
    const last = rows[rows.length - 1]
    const nextCursor =
      hasMore && last
        ? Buffer.from(canonical({ format: 1, ...this.#binding, lastKey: last.key })).toString(
            'base64url',
          )
        : null
    const exhaustiveAnswerEligible =
      this.#snapshot.coverage === 'COMPLETE' && this.#unknownKeys.length === 0
    return {
      mode: this.#mode,
      domain: this.#domain,
      candidateCount: this.#candidateCount,
      domainContract: GUEST_QUERY_DOMAIN_CONTRACT,
      tenantId: this.#binding.tenantId,
      venueId: this.#binding.venueId,
      sourceVersion: this.#binding.sourceVersion,
      asOf: this.#snapshot.asOf,
      coverage: this.#snapshot.coverage,
      queryIdentity: this.queryIdentity,
      knownMatchCount: this.#matches.length,
      unknownCandidateCount: this.#unknownKeys.length,
      // The compatibility result contract intentionally still allocates O(matches + unknowns) IDs.
      matchingKeys: [...this.#matchingKeys],
      unknownKeys: [...this.#unknownKeys],
      rows: structuredClone(rows),
      returnedCount: rows.length,
      hasMore,
      nextCursor,
      exhaustiveAnswerEligible,
      exactEligibleCount: exhaustiveAnswerEligible ? this.#matches.length : null,
      inventoryScope: 'STORED_RECORDS_ONLY',
    }
  }
}

/** Defensive ownership and full validation happen once before a handle is exposed. */
export function prepareGuestStructuredSnapshot(raw: unknown): PreparedGuestSnapshot {
  const snapshot = structuredClone(raw)
  validateSnapshot(snapshot)
  return new PreparedSnapshot(PREPARED_TOKEN, snapshot as GuestStructuredSnapshot)
}

export function isPreparedGuestSnapshot(value: unknown): value is PreparedGuestSnapshot {
  return PreparedSnapshot.is(value)
}

/** Safe compatibility entry point; optimized callers retain only their private per-turn handle. */
export function executeGuestStructuredQuery(
  snapshot: GuestStructuredSnapshot,
  query: GuestStructuredQuery,
  page: GuestStructuredQueryPage = {},
): GuestStructuredQueryResult {
  return prepareGuestStructuredSnapshot(snapshot).evaluate(query).page(page)
}
