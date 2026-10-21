import { describe, expect, it, vi } from 'vitest'
import {
  executeGuestStructuredQuery as execute,
  GuestStructuredQueryError,
  prepareGuestStructuredSnapshot,
  isPreparedGuestSnapshot,
  type GuestQueryEvidence,
  type GuestQueryFact,
  type GuestStructuredPredicate,
  type GuestStructuredQuery,
  type GuestStructuredRecord,
  type GuestStructuredSnapshot,
} from './guest-structured-query'

const evidence = (sourceKey: string): GuestQueryEvidence[] => [
  { sourceKey, fieldPath: 'published.description' },
]
const known = <T>(value: T, sourceKey: string): GuestQueryFact<T> => ({
  state: 'KNOWN',
  value,
  sources: evidence(sourceKey),
})
const record = (id: string, name = id): GuestStructuredRecord => ({
  key: `place:${id}`,
  tenantId: 'tenant1',
  venueId: 'venue1',
  name,
})
const snapshot = (records: GuestStructuredRecord[]): GuestStructuredSnapshot => ({
  tenantId: 'tenant1',
  venueId: 'venue1',
  version: 'v1',
  asOf: '2026-10-21T04:00:00.000Z',
  coverage: 'COMPLETE',
  records,
})
const query = (...predicates: GuestStructuredPredicate[]): GuestStructuredQuery => ({
  tenantId: 'tenant1',
  venueId: 'venue1',
  mode: 'list',
  predicates,
})
const count = (s: GuestStructuredSnapshot, ...ps: GuestStructuredPredicate[]) =>
  execute(s, { ...query(...ps), mode: 'count' })

describe('private immutable prepared snapshots', () => {
  it('owns source arrays, nested facts and evidence independently of later caller mutation', () => {
    const r = record('a', 'Shop')
    r.aliases = ['Alias']
    r.kind = known('SHOP', 'revision:1')
    r.features = { family: known(true, 'revision:1') }
    r.products = {
      state: 'KNOWN',
      completeness: 'COMPLETE',
      sources: evidence('revision:1'),
      offers: [{ name: 'Poncho', sources: evidence('revision:1') }],
    }
    const s = { ...snapshot([r]), evidenceKeys: ['revision:1'] }
    const before = structuredClone(s)
    const prepared = prepareGuestStructuredSnapshot(s)
    const identity = prepared.snapshotIdentity
    s.tenantId = 'changed'
    s.version = 'changed'
    s.evidenceKeys.length = 0
    r.name = 'Changed'
    ;(r.aliases as string[])[0] = 'Changed alias'
    if (r.kind.state === 'KNOWN') r.kind.value = 'RIDE'
    if (r.features.family?.state === 'KNOWN') r.features.family.value = false
    r.products.offers[0]!.name = 'Changed product'
    ;(s.records as GuestStructuredRecord[]).length = 0
    const q = query(
      { field: 'name', equals: 'Alias' },
      { field: 'kind', equals: 'SHOP' },
      { field: 'product', name: 'Poncho' },
      { field: 'feature', name: 'family', value: true },
    )
    expect(prepared.evaluate(q).page()).toEqual(execute(before, q))
    expect(prepared.snapshotIdentity).toBe(identity)
  })

  it('returns fresh scope/vocabulary/query/results rather than writable internal state', () => {
    const r = record('a')
    r.kind = known('SHOP', r.key)
    const prepared = prepareGuestStructuredSnapshot(snapshot([r]))
    const scope = prepared.scope as { tenantId: string; venueId: string }
    scope.tenantId = 'bad'
    const vocab = prepared.planningVocabulary()
    ;(vocab.kinds as string[])[0] = 'bad'
    const q = prepared.validateQuery(query({ field: 'kind', equals: 'SHOP' }))
    const evaluated = prepared.evaluate(q)
    q.tenantId = 'bad'
    const predicate = q.predicates[0]!
    if (predicate.field === 'kind') predicate.equals = 'RIDE'
    const first = evaluated.page()
    first.rows[0]!.name = 'Changed row'
    first.matchingKeys.length = 0
    first.unknownKeys.push('place:forged')
    expect(prepared.scope.tenantId).toBe('tenant1')
    expect(prepared.planningVocabulary().kinds).toEqual(['SHOP'])
    expect(evaluated.page()).toMatchObject({
      knownMatchCount: 1,
      unknownCandidateCount: 0,
      matchingKeys: ['place:a'],
      unknownKeys: [],
    })
    expect(evaluated.page().rows[0]!.name).toBe('a')
  })

  it('cannot be forged by JSON, a copied object, a forged prototype or a public constructor token', () => {
    const prepared = prepareGuestStructuredSnapshot(snapshot([record('a')]))
    expect(isPreparedGuestSnapshot(prepared)).toBe(true)
    expect(isPreparedGuestSnapshot(JSON.parse(JSON.stringify(prepared)))).toBe(false)
    expect(isPreparedGuestSnapshot({ ...prepared, validated: true })).toBe(false)
    expect(isPreparedGuestSnapshot(Object.create(Object.getPrototypeOf(prepared)))).toBe(false)
    const Constructor = prepared.constructor as new (...args: unknown[]) => unknown
    expect(() => new Constructor(Symbol('forged'), snapshot([]))).toThrow(/construction/)
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(() => prepareGuestStructuredSnapshot(snapshot([record('a'), record('a')]))).toThrow(
      /duplicate/,
    )
  })

  it('does no predicate normalization during small-query validation or repeated pagination', () => {
    const prepared = prepareGuestStructuredSnapshot(
      snapshot([record('a', 'Same'), record('b', 'Same'), record('c', 'Same')]),
    )
    const normalization = vi.spyOn(String.prototype, 'normalize')
    try {
      const q = prepared.validateQuery(query({ field: 'name', equals: 'Same' }))
      expect(normalization).not.toHaveBeenCalled()
      const evaluated = prepared.evaluate(q)
      expect(normalization.mock.calls.length).toBeGreaterThan(0)
      const afterEvaluation = normalization.mock.calls.length
      const first = evaluated.page({ pageSize: 1 })
      const second = evaluated.page({ cursor: first.nextCursor!, pageSize: 1 })
      const third = evaluated.page({ cursor: second.nextCursor!, pageSize: 1 })
      expect(third.hasMore).toBe(false)
      expect(normalization.mock.calls.length).toBe(afterEvaluation)
    } finally {
      normalization.mockRestore()
    }
  })

  it('preserves exact wrapper results/cursors and later-asOf continuation across prepared instances', () => {
    const s = snapshot([record('c'), record('a'), record('b')])
    const prepared = prepareGuestStructuredSnapshot(s)
    const q = query()
    const first = prepared.evaluate(q).page({ pageSize: 1 })
    expect(first).toEqual(execute(s, q, { pageSize: 1 }))
    const later = prepareGuestStructuredSnapshot({ ...s, asOf: '2026-10-21T06:00:00.000Z' })
    expect(later.snapshotIdentity).toBe(prepared.snapshotIdentity)
    const second = later.evaluate(q).page({ cursor: first.nextCursor!, pageSize: 1 })
    expect(second.rows[0]!.key).toBe('place:b')
    expect(second.asOf).toBe('2026-10-21T06:00:00.000Z')
    expect(() =>
      later.evaluate({ ...q, mode: 'count' }).page({ cursor: first.nextCursor! }),
    ).toThrow(/changed/)
  })

  it('keeps withdrawn evidence UNKNOWN in new leases and does not mutate an older admitted lease', () => {
    const a = record('a'),
      b = record('b')
    a.kind = known('SHOP', 'revision:1')
    b.kind = known('SHOP', 'revision:1')
    const s = { ...snapshot([a, b]), evidenceKeys: ['revision:1'] }
    const q = query({ field: 'kind', equals: 'SHOP' })
    const old = prepareGuestStructuredSnapshot(s).evaluate(q)
    const first = old.page({ pageSize: 1 })
    const withdrawn = prepareGuestStructuredSnapshot({ ...s, evidenceKeys: [] }).evaluate(q)
    expect(withdrawn.page()).toMatchObject({
      knownMatchCount: 0,
      unknownCandidateCount: 2,
      exactEligibleCount: null,
    })
    expect(() => withdrawn.page({ cursor: first.nextCursor! })).toThrow(/changed/)
    expect(old.page().knownMatchCount).toBe(2)
  })
})

describe('guest structured query: exhaustive arithmetic and pagination', () => {
  it('counts the full 10,000-record set, including matches beyond prior 400/top-k bounds', () => {
    const records = Array.from({ length: 10_000 }, (_, i) => {
      const r = record(String(i).padStart(5, '0'))
      r.features = { family: known(i >= 400 && i % 2 === 0, r.key) }
      return r
    })
    const result = execute(
      snapshot(records),
      query({ field: 'feature', name: 'family', value: true }),
      { pageSize: 3 },
    )
    expect(result.knownMatchCount).toBe(4800)
    expect(result.exactEligibleCount).toBe(4800)
    expect(result.unknownCandidateCount).toBe(0)
    expect(result.matchingKeys).toHaveLength(4800)
    expect(result.matchingKeys.at(-1)).toBe('place:09998')
    expect(result.rows.map((r) => r.key)).toEqual(['place:00400', 'place:00402', 'place:00404'])
    expect(result.returnedCount).toBe(3)
    expect(result.hasMore).toBe(true)
    expect(result.inventoryScope).toBe('STORED_RECORDS_ONLY')
  })

  it('returns stable complete pages without duplicates, independent of incoming row order', () => {
    const s = snapshot(['z', 'a', 'm', 'c', 'b'].map((id) => record(id)))
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const result = execute(s, query(), {
        pageSize: 2,
        ...(cursor === undefined ? {} : { cursor }),
      })
      keys.push(...result.rows.map((r) => r.key))
      expect(result.knownMatchCount).toBe(5)
      expect(result.matchingKeys).toEqual(['place:a', 'place:b', 'place:c', 'place:m', 'place:z'])
      cursor = result.nextCursor ?? undefined
      s.records = [...s.records].reverse()
    } while (cursor)
    expect(keys).toEqual(['place:a', 'place:b', 'place:c', 'place:m', 'place:z'])
    expect(new Set(keys).size).toBe(5)
  })

  it('reports empty exact stored inventory only with complete coverage and no unknowns', () => {
    const result = count(snapshot([]))
    expect(result).toMatchObject({
      knownMatchCount: 0,
      unknownCandidateCount: 0,
      exactEligibleCount: 0,
      exhaustiveAnswerEligible: true,
      rows: [],
      hasMore: false,
      nextCursor: null,
    })
  })

  it('does not mutate inputs or return aliases to source rows', () => {
    const r = record('a')
    r.aliases = ['Alias']
    r.kind = known('SHOP', r.key)
    const s = snapshot([r])
    const q = query({ field: 'kind', equals: 'SHOP' })
    const before = JSON.stringify({ s, q })
    const result = execute(s, q)
    result.rows[0]!.name = 'changed'
    expect(JSON.stringify({ s, q })).toBe(before)
    expect(result.rows[0]).not.toBe(r)
  })
})

describe('exact typed predicates and explicit identity', () => {
  it('distinguishes duplicate names across kind and area without substring inference', () => {
    const shop = record('shop', 'Moon Hall')
    shop.kind = known('SHOP', shop.key)
    shop.area = known('East', shop.key)
    const ride = record('ride', 'Moon Hall')
    ride.kind = known('RIDE', ride.key)
    ride.area = known('West', ride.key)
    const longer = record('longer', 'Moon Hall Annex')
    longer.kind = known('SHOP', longer.key)
    longer.area = known('East', longer.key)
    expect(
      count(
        snapshot([ride, longer, shop]),
        { field: 'name', equals: 'moon hall' },
        { field: 'kind', equals: 'shop' },
        { field: 'area', equals: 'east' },
      ).matchingKeys,
    ).toEqual([shop.key])
  })

  it('uses explicit aliases and limited Unicode punctuation/whitespace equivalence', () => {
    const r = record('a', 'Dot’s Frozen Delights')
    r.aliases = ['Ice–Cream  Cart']
    const s = snapshot([r])
    expect(count(s, { field: 'name', equals: "DOT'S FROZEN DELIGHTS" }).knownMatchCount).toBe(1)
    expect(count(s, { field: 'name', equals: ' ice-cream cart ' }).knownMatchCount).toBe(1)
    expect(count(s, { field: 'name', equals: 'Frozen Delights' }).knownMatchCount).toBe(0)
    expect(count(s, { field: 'name', equals: 'ice cream cart' }).knownMatchCount).toBe(0)
  })

  it('distinguishes exact products from longer variants and positive-only enumeration', () => {
    const complete = record('complete')
    complete.products = {
      state: 'KNOWN',
      completeness: 'COMPLETE',
      sources: evidence(complete.key),
      offers: [{ name: 'Falafel bowl deluxe', sources: evidence(complete.key) }],
    }
    const positive = record('positive')
    positive.products = {
      state: 'KNOWN',
      completeness: 'POSITIVE_ONLY',
      sources: evidence(positive.key),
      offers: [{ name: 'Falafel bowl deluxe', sources: evidence(positive.key) }],
    }
    const match = record('match')
    match.products = {
      state: 'KNOWN',
      completeness: 'POSITIVE_ONLY',
      sources: evidence(match.key),
      offers: [{ name: 'Falafel bowl', sources: evidence(match.key) }],
    }
    const result = count(snapshot([complete, positive, match]), {
      field: 'product',
      name: 'FALAFEL BOWL',
    })
    expect(result.matchingKeys).toEqual([match.key])
    expect(result.unknownKeys).toEqual([positive.key])
    expect(result.exactEligibleCount).toBeNull()
  })

  it('requires evidence to prove absence from an explicitly complete empty product set', () => {
    const r = record('a')
    r.products = {
      state: 'KNOWN',
      completeness: 'COMPLETE',
      sources: evidence('place:unavailable'),
      offers: [],
    }
    expect(count(snapshot([r]), { field: 'product', name: 'Towel' }).unknownCandidateCount).toBe(1)
    r.products = { ...r.products, sources: evidence(r.key) }
    expect(count(snapshot([r]), { field: 'product', name: 'Towel' }).unknownCandidateCount).toBe(0)
  })

  it('accepts typed authoritative paths and prose spans but treats unresolved provenance as unsupported', () => {
    const r = record('a')
    r.kind = { state: 'KNOWN', value: 'SHOP', sources: [{ sourceKey: r.key, start: 0, end: 4 }] }
    expect(count(snapshot([r]), { field: 'kind', equals: 'SHOP' }).knownMatchCount).toBe(1)
    r.kind = {
      state: 'KNOWN',
      value: 'SHOP',
      sources: [{ sourceKey: 'place:absent', fieldPath: 'kind' }],
    }
    expect(count(snapshot([r]), { field: 'kind', equals: 'SHOP' }).unknownKeys).toEqual([r.key])
  })
})

describe('three-valued facts', () => {
  it('uses explicit current evidence membership for external revision documents and withdrawals', () => {
    const r = record('a')
    r.kind = known('SHOP', 'revision:published-7')
    const s = { ...snapshot([r]), evidenceKeys: ['revision:published-7'] }
    expect(count(s, { field: 'kind', equals: 'SHOP' }).matchingKeys).toEqual([r.key])
    expect(count(snapshot([r]), { field: 'kind', equals: 'SHOP' }).unknownKeys).toEqual([r.key])
    expect(
      count({ ...s, evidenceKeys: [] }, { field: 'kind', equals: 'SHOP' }).unknownKeys,
    ).toEqual([r.key])
    r.kind = known('SHOP', r.key)
    expect(count(s, { field: 'kind', equals: 'SHOP' }).unknownKeys).toEqual([r.key])
  })

  it('rejects invalid/duplicate evidence keys and invalidates cursors on authority withdrawal', () => {
    const s = {
      ...snapshot([record('a'), record('b')]),
      evidenceKeys: ['revision:v1', 'revision:v2'],
    }
    const cursor = execute(s, query(), { pageSize: 1 }).nextCursor!
    expect(
      execute({ ...s, evidenceKeys: [...s.evidenceKeys].reverse() }, query(), { cursor })
        .returnedCount,
    ).toBe(1)
    expect(() => execute({ ...s, evidenceKeys: ['revision:v1'] }, query(), { cursor })).toThrow(
      /changed/,
    )
    expect(() => execute({ ...s, evidenceKeys: ['revision:v1', 'revision:v1'] }, query())).toThrow(
      /duplicate evidence/,
    )
    expect(() => execute({ ...s, evidenceKeys: ['unnamespaced'] }, query())).toThrow(/namespaced/)
  })
  it('handles true, false, absent, unknown, conflicting and unsupported facts', () => {
    const rows = ['yes', 'no', 'missing', 'unknown', 'conflict', 'unsupported'].map((id) =>
      record(id),
    )
    rows[0]!.features = { family: known(true, rows[0]!.key) }
    rows[1]!.features = { family: known(false, rows[1]!.key) }
    rows[3]!.features = { family: { state: 'UNKNOWN' } }
    rows[4]!.features = {
      family: { state: 'CONFLICTING', values: [true, false], sources: evidence(rows[4]!.key) },
    }
    rows[5]!.features = {
      family: { state: 'KNOWN', value: true, sources: evidence('place:unavailable') },
    }
    const result = count(snapshot(rows), { field: 'feature', name: 'FAMILY', value: true })
    expect(result.matchingKeys).toEqual(['place:yes'])
    expect(result.unknownKeys).toEqual([
      'place:conflict',
      'place:missing',
      'place:unknown',
      'place:unsupported',
    ])
    expect(
      count(snapshot(rows), { field: 'feature', name: 'family', value: false }).matchingKeys,
    ).toEqual(['place:no'])
  })

  it('proven false excludes even when another predicate is unknown, regardless of order', () => {
    const r = record('a')
    r.kind = known('SHOP', r.key)
    const kind: GuestStructuredPredicate = { field: 'kind', equals: 'RIDE' }
    const area: GuestStructuredPredicate = { field: 'area', equals: 'North' }
    for (const ps of [
      [kind, area],
      [area, kind],
    ]) {
      expect(count(snapshot([r]), ...ps)).toMatchObject({
        knownMatchCount: 0,
        unknownCandidateCount: 0,
        exactEligibleCount: 0,
      })
    }
  })

  it('withholds exact eligible counts for partial coverage and for zero matches with unknowns', () => {
    const r = record('a')
    const zero = count(snapshot([r]), { field: 'feature', name: 'family', value: true })
    expect(zero).toMatchObject({
      knownMatchCount: 0,
      unknownCandidateCount: 1,
      exhaustiveAnswerEligible: false,
      exactEligibleCount: null,
    })
    const partial = count({ ...snapshot([r]), coverage: 'PARTIAL' })
    expect(partial).toMatchObject({
      knownMatchCount: 1,
      unknownCandidateCount: 0,
      exhaustiveAnswerEligible: false,
      exactEligibleCount: null,
    })
  })

  it('unknown and conflicting products remain unknown', () => {
    const unknown = record('unknown')
    unknown.products = { state: 'UNKNOWN' }
    const conflict = record('conflict')
    conflict.products = { state: 'CONFLICTING', sources: evidence(conflict.key) }
    expect(
      count(snapshot([unknown, conflict]), { field: 'product', name: 'Towel' })
        .unknownCandidateCount,
    ).toBe(2)
  })

  it('does not turn unsupported offers into negative evidence', () => {
    const r = record('a')
    r.products = {
      state: 'KNOWN',
      completeness: 'COMPLETE',
      sources: evidence(r.key),
      offers: [{ name: 'Towel', sources: evidence('place:unavailable') }],
    }
    for (const name of ['Towel', 'Poncho'])
      expect(count(snapshot([r]), { field: 'product', name }).unknownCandidateCount).toBe(1)
  })
})

describe('runtime validation and cursor custody', () => {
  const unsafeExecute = (s: unknown, q: unknown = query(), page: unknown = {}) =>
    execute(s as GuestStructuredSnapshot, q as GuestStructuredQuery, page as never)

  it('rejects duplicate keys, unnamespaced keys and source scope mismatches', () => {
    expect(() => execute(snapshot([record('a'), record('a')]), query())).toThrow(/duplicate/)
    expect(() => execute(snapshot([{ ...record('a'), key: 'a' }]), query())).toThrow(/namespaced/)
    for (const change of [{ tenantId: 'other' }, { venueId: 'other' }])
      expect(() => execute(snapshot([{ ...record('a'), ...change }]), query())).toThrow(/scope/)
    expect(() => execute(snapshot([record('a')]), { ...query(), tenantId: 'other' })).toThrow(
      /scope/,
    )
  })

  it.each([0, -1, 201, 1.5, NaN, Infinity, '3'])(`rejects invalid page bound %s`, (pageSize) => {
    expect(() => unsafeExecute(snapshot([]), query(), { pageSize })).toThrow(
      GuestStructuredQueryError,
    )
  })

  it('rejects malformed facts, unsupported predicates, duplicate normalized features and unexpected fields', () => {
    expect(() => unsafeExecute({ ...snapshot([]), version: '' })).toThrow()
    expect(() => unsafeExecute({ ...snapshot([]), asOf: 'yesterday' })).toThrow()
    expect(() => unsafeExecute({ ...snapshot([]), coverage: 'ALL' })).toThrow()
    expect(() =>
      unsafeExecute(snapshot([]), { ...query(), predicates: [{ field: 'fuzzy', equals: 'a' }] }),
    ).toThrow()
    expect(() =>
      unsafeExecute(snapshot([]), {
        ...query(),
        predicates: [{ field: 'name', equals: 'a', or: [] }],
      }),
    ).toThrow()
    expect(() =>
      unsafeExecute(snapshot([]), {
        ...query(),
        predicates: Array(33).fill({ field: 'name', equals: 'a' }),
      }),
    ).toThrow()
    expect(() =>
      unsafeExecute(
        snapshot([
          {
            ...record('a'),
            features: { family: { state: 'KNOWN', value: 'yes', sources: [] } },
          } as never,
        ]),
      ),
    ).toThrow()
    expect(() =>
      unsafeExecute(
        snapshot([
          {
            ...record('a'),
            features: { family: known(true, 'place:a'), FAMILY: known(false, 'place:a') },
          },
        ]),
      ),
    ).toThrow(/duplicate normalized/)
  })

  it.each(['2026-02-30T04:00:00Z', '2026-10-21T24:00:00Z', '2026-02-29T04:00:00Z'])(
    'rejects normalized invalid calendar timestamps %s',
    (asOf) => {
      expect(() => unsafeExecute({ ...snapshot([]), asOf })).toThrow(/timestamp/)
    },
  )

  it('rejects empty source arrays on known/conflicting facts, product sets and product observations', () => {
    const r = record('a')
    for (const kind of [
      { state: 'KNOWN', value: 'SHOP', sources: [] },
      { state: 'CONFLICTING', values: ['SHOP', 'RIDE'], sources: [] },
    ])
      expect(() => unsafeExecute(snapshot([{ ...r, kind } as never]))).toThrow(/nonempty source/)
    for (const products of [
      { state: 'CONFLICTING', sources: [] },
      { state: 'KNOWN', completeness: 'COMPLETE', sources: [], offers: [] },
      {
        state: 'KNOWN',
        completeness: 'POSITIVE_ONLY',
        sources: evidence(r.key),
        offers: [{ name: 'Poncho', sources: [] }],
      },
    ])
      expect(() => unsafeExecute(snapshot([{ ...r, products } as never]))).toThrow(
        /nonempty source/,
      )
  })

  it.each([
    { sourceKey: 'place:a', start: -1, end: 4 },
    { sourceKey: 'place:a', start: 4, end: 4 },
    { sourceKey: 'place:a', start: 0, end: 2.5 },
    { sourceKey: 'place:a', fieldPath: '' },
    { sourceKey: 'place:a', fieldPath: '__proto__.polluted' },
    { sourceKey: 'place:a', fieldPath: 'name;drop' },
    { sourceKey: 'place:a', fieldPath: 'name', start: 0, end: 3 },
  ])('rejects invalid evidence %j', (source) => {
    const r = { ...record('a'), kind: { state: 'KNOWN', value: 'SHOP', sources: [source] } }
    expect(() => unsafeExecute(snapshot([r as never]))).toThrow()
  })

  it('binds continuation to exact query, tenant, venue and source version', () => {
    const s = snapshot([record('a'), record('b')])
    const q = query()
    const cursor = execute(s, q, { pageSize: 1 }).nextCursor!
    expect(execute(s, q, { cursor }).rows.map((r) => r.key)).toEqual(['place:b'])
    expect(
      execute({ ...s, asOf: '2026-10-21T05:00:00.000Z' }, q, { cursor }).rows.map((r) => r.key),
    ).toEqual(['place:b'])
    expect(() => execute({ ...s, version: 'v2' }, q, { cursor })).toThrow(/changed/)
    expect(() => execute(s, { ...q, mode: 'count' }, { cursor })).toThrow(/changed/)
    expect(() => execute(s, query({ field: 'name', equals: 'a' }), { cursor })).toThrow(/changed/)
    for (const field of ['tenantId', 'venueId'] as const) {
      const changed = {
        ...s,
        [field]: 'new',
        records: s.records.map((r) => ({ ...r, [field]: 'new' })),
      }
      expect(() => execute(changed, { ...q, [field]: 'new' }, { cursor })).toThrow(/changed/)
    }
    expect(() => execute(s, q, { cursor: 'invalid!!!' })).toThrow(/cursor/)
  })

  it('rejects cursors after updates/removals even if an adapter accidentally reuses a version', () => {
    const s = snapshot([record('a'), record('b')])
    const cursor = execute(s, query(), { pageSize: 1 }).nextCursor!
    const changed = snapshot([record('a', 'new name'), record('b')])
    expect(() => execute(changed, query(), { cursor })).toThrow(/changed/)
    const removed = { ...snapshot([record('b')]), version: 'v2' }
    expect(() => execute(removed, query(), { cursor })).toThrow(/changed/)
    expect(count(removed).matchingKeys).toEqual(['place:b'])
    expect(count(s).matchingKeys).toEqual(['place:a', 'place:b'])
  })
})
