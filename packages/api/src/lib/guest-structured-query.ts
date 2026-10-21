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

export interface GuestStructuredRecord {
  key: string
  tenantId: string
  venueId: string
  name: string
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
  | { field: 'name'; equals: string }
  | { field: 'kind'; equals: string }
  | { field: 'area'; equals: string }
  | { field: 'product'; name: string }
  | { field: 'feature'; name: string; value: boolean }

export interface GuestStructuredQuery {
  tenantId: string
  venueId: string
  mode: 'count' | 'list'
  predicates: readonly GuestStructuredPredicate[]
}

export interface GuestStructuredQueryPage {
  pageSize?: number
  cursor?: string
}

export interface GuestStructuredQueryResult {
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

function validate(snapshot: unknown, query: unknown, page: unknown) {
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
      ['key', 'tenantId', 'venueId', 'name', 'aliases', 'kind', 'area', 'products', 'features'],
      'record',
    )
    key(r.key, 'record.key')
    if (keys.has(r.key)) fail('snapshot: duplicate record key')
    keys.add(r.key)
    if (r.tenantId !== s.tenantId || r.venueId !== s.venueId) fail('record: scope mismatch')
    string(r.name, 'record.name')
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
  const q = object(query, 'query')
  fields(q, ['tenantId', 'venueId', 'mode', 'predicates'], 'query')
  if (q.tenantId !== s.tenantId || q.venueId !== s.venueId) fail('query: scope mismatch')
  if (!['count', 'list'].includes(q.mode as string)) fail('query: invalid mode')
  if (!Array.isArray(q.predicates) || q.predicates.length > MAX_PREDICATES)
    fail('query: invalid predicate count')
  for (const value of q.predicates) {
    const p = object(value, 'predicate')
    if (['name', 'kind', 'area'].includes(p.field as string)) {
      fields(p, ['field', 'equals'], 'predicate')
      string(p.equals, 'predicate.equals')
    } else if (p.field === 'product') {
      fields(p, ['field', 'name'], 'predicate')
      string(p.name, 'predicate.name')
    } else if (p.field === 'feature') {
      fields(p, ['field', 'name', 'value'], 'predicate')
      string(p.name, 'predicate.name', 128)
      if (typeof p.value !== 'boolean') fail('predicate: expected boolean value')
    } else fail('predicate: unsupported field')
  }
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

export function executeGuestStructuredQuery(
  snapshot: GuestStructuredSnapshot,
  query: GuestStructuredQuery,
  page: GuestStructuredQueryPage = {},
): GuestStructuredQueryResult {
  validate(snapshot, query, page)
  const records = [...snapshot.records].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const keys = new Set(snapshot.evidenceKeys ?? records.map((record) => record.key))
  const queryIdentity = hash(query)
  // Observation time is not a content version. A later read of the same scoped inventory
  // may continue; a changed record or coverage declaration still invalidates the cursor.
  const snapshotIdentity = hash({
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    version: snapshot.version,
    coverage: snapshot.coverage,
    records,
    evidenceKeys:
      snapshot.evidenceKeys === undefined ? undefined : [...snapshot.evidenceKeys].sort(),
  })
  const binding = {
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    sourceVersion: snapshot.version,
    snapshotIdentity,
    queryIdentity,
  }
  let after: string | undefined
  if (page.cursor !== undefined) {
    let cursor: ObjectValue
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(page.cursor)) fail('cursor: invalid encoding')
      cursor = object(JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')), 'cursor')
    } catch {
      fail('cursor: invalid encoding or payload')
    }
    fields(cursor, ['format', ...Object.keys(binding), 'lastKey'], 'cursor')
    if (
      cursor.format !== 1 ||
      Object.entries(binding).some(([key, value]) => cursor[key] !== value)
    )
      fail('cursor: snapshot, scope or query changed')
    key(cursor.lastKey, 'cursor.lastKey')
    after = cursor.lastKey
  }
  const matches: GuestStructuredRecord[] = []
  const unknownKeys: string[] = []
  for (const record of records) {
    const values = query.predicates.map((predicate) => test(record, predicate, keys))
    if (values.includes('FALSE')) continue
    if (values.includes('UNKNOWN')) unknownKeys.push(record.key)
    else matches.push(record)
  }
  const start = after === undefined ? 0 : matches.findIndex((record) => record.key === after) + 1
  if (after !== undefined && start === 0) fail('cursor: continuation key is not a known match')
  const rows = matches.slice(start, start + (page.pageSize ?? 50))
  const hasMore = start + rows.length < matches.length
  const last = rows[rows.length - 1]
  const nextCursor =
    hasMore && last
      ? Buffer.from(canonical({ format: 1, ...binding, lastKey: last.key })).toString('base64url')
      : null
  const exhaustiveAnswerEligible = snapshot.coverage === 'COMPLETE' && unknownKeys.length === 0
  return {
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    sourceVersion: snapshot.version,
    asOf: snapshot.asOf,
    coverage: snapshot.coverage,
    queryIdentity,
    knownMatchCount: matches.length,
    unknownCandidateCount: unknownKeys.length,
    matchingKeys: matches.map((record) => record.key),
    unknownKeys,
    rows: structuredClone(rows),
    returnedCount: rows.length,
    hasMore,
    nextCursor,
    exhaustiveAnswerEligible,
    exactEligibleCount: exhaustiveAnswerEligible ? matches.length : null,
    inventoryScope: 'STORED_RECORDS_ONLY',
  }
}
