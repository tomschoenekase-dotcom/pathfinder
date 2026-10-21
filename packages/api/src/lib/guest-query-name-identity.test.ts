import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { guestQueryPlanningPrompt, parseGuestQueryPlan } from './guest-query-planning'
import { prepareGuestStructuredSnapshot, MAX_NAMED_INDEX_ENTRIES, type GuestStructuredRecord, type GuestStructuredSnapshot } from './guest-structured-query'
const record = (id: string, name: string, aliases?: string[]): GuestStructuredRecord => ({ key: `place:${id}`, tenantId: 'tenant', venueId: 'venue', name, entityDomain: 'PLACE', ...(aliases ? { aliases } : {}), kind: { state: 'KNOWN', value: 'event', sources: [{ sourceKey: `place:${id}`, fieldPath: 'kind' }] }, area: { state: 'KNOWN', value: 'Meadow Habitat', sources: [{ sourceKey: `place:${id}`, fieldPath: 'area' }] } })
const snapshot = (records: GuestStructuredRecord[], version = 'v1'): GuestStructuredSnapshot => ({ tenantId: 'tenant', venueId: 'venue', version, asOf: '2026-10-21T05:00:00.000Z', coverage: 'COMPLETE', records })
const query = (predicates: unknown[]) => JSON.stringify({ status: 'QUERY', mode: 'list', domain: 'PLACE', predicates })
const context = (prepared: ReturnType<typeof prepareGuestStructuredSnapshot>, question: string) => ({ question, catalog: prepared.discoverNamedCandidates(question) })
const count = (prepared: ReturnType<typeof prepareGuestStructuredSnapshot>) => prepared.evaluate({ tenantId: 'tenant', venueId: 'venue', mode: 'count', predicates: [] }).page().exactEligibleCount

describe('current-question exact name identity', () => {
  it.each(['list', 'count'] as const)('keeps a unique alias bound to its resolved key for %s, including copied canonical names', mode => {
    const prepared = prepareGuestStructuredSnapshot(snapshot([
      record('a', 'Alpha', ['Unique counter']),
      record('b', 'Beta', ['Alpha']),
    ]))
    const names = context(prepared, 'Show Unique counter')
    for (const name of ['Unique counter', 'Alpha']) {
      const plan = parseGuestQueryPlan(JSON.stringify({ status: 'QUERY', mode, domain: 'PLACE', predicates: [{ field: 'name', equals: name }, { field: 'area', equals: 'Meadow Habitat' }] }), prepared, names)
      if (plan.status !== 'QUERY') throw Error('Expected query')
      expect(plan.query.predicates).toEqual([{ field: 'key', equals: 'place:a' }, { field: 'area', equals: 'Meadow Habitat' }])
      expect(prepared.evaluate(plan.query).page().knownMatchCount).toBe(1)
      const impossible = { ...plan.query, predicates: [...plan.query.predicates, { field: 'area' as const, equals: 'Other' }] }
      expect(prepared.evaluate(impossible).page().knownMatchCount).toBe(0)
    }
  })
  it('rejects unexpected name fields before replacing a validated name with a key', () => {
    const prepared = prepareGuestStructuredSnapshot(snapshot([record('a', 'Alpha')]))
    const names = context(prepared, 'Show Alpha')
    for (const extra of [{ ref: 'n0' }, { value: false }, { scope: 'other' }]) {
      expect(() => parseGuestQueryPlan(query([{ field: 'name', equals: 'Alpha', ...extra }]), prepared, names)).toThrow(/Invalid entity name/)
    }
  })
  it('resolves the full named identity without splitting or discarding any AND constraint', () => {
    const prepared = prepareGuestStructuredSnapshot(snapshot([record('target', 'Meadow Habitat event 00049')]))
    const names = context(prepared, 'Quote conditions for Meadow Habitat event 00049.')
    const tail = [{ field: 'kind', equals: 'event' }, { field: 'area', equals: 'Meadow Habitat' }]
    expect(() => parseGuestQueryPlan(query([{ field: 'name', equals: 'event 00049' }, ...tail]), prepared, names)).toThrow(/unresolved/)
    const plan = parseGuestQueryPlan(query([{ field: 'entity', ref: 'n0' }, ...tail]), prepared, names)
    if (plan.status !== 'QUERY') throw Error('Expected query')
    expect(plan.query.predicates).toEqual([{ field: 'key', equals: 'place:target' }, ...tail])
    expect(prepared.evaluate(plan.query).page().matchingKeys).toEqual(['place:target'])
    const impossible = parseGuestQueryPlan(query([{ field: 'entity', ref: 'n0' }, ...tail, { field: 'area', equals: 'Other' }]), prepared, names)
    if (impossible.status !== 'QUERY') throw Error('Expected query')
    expect(impossible.query.predicates).toHaveLength(4)
    expect(prepared.evaluate(impossible.query).page().matchingKeys).toEqual([])
  })
  it('accepts full names and existing explicit aliases but never suffixes, fuzzy or product punctuation guesses', () => {
    const prepared = prepareGuestStructuredSnapshot(snapshot([record('a', 'Cedar Field offering 00004', ['Northern counter']), record('b', "Dippin’ Dots")]))
    const names = context(prepared, 'At Northern counter, quote its conditions.')
    for (const name of ['Cedar Field offering 00004', 'Northern counter']) expect(() => parseGuestQueryPlan(query([{ field: 'name', equals: name }]), prepared, names)).not.toThrow()
    for (const name of ['offering 00004', 'Northern counters', 'DippinDots']) expect(() => parseGuestQueryPlan(query([{ field: 'name', equals: name }]), prepared, names)).toThrow()
    expect(context(prepared, 'Where is DippinDots?').catalog.data.groups).toEqual([])
    expect(context(prepared, "Where is Dippin' Dots?").catalog.data.groups[0]?.record?.key).toBe('place:b')
  })
  it('leaves historical parser callers and their exact name predicates compatible without a catalog', () => {
    const prepared = prepareGuestStructuredSnapshot(snapshot([record('a', 'Full name')]))
    const value = parseGuestQueryPlan(query([{ field: 'name', equals: 'unknown full identity' }]), prepared)
    if (value.status !== 'QUERY') throw Error('Expected legacy query')
    expect(value.query.predicates).toEqual([{ field: 'name', equals: 'unknown full identity' }])
    expect(prepared.evaluate(value.query).page().knownMatchCount).toBe(0)
  })
  it('rejects raw model keys, unknown refs, extra ref properties and refs without bound context', () => {
    const prepared = prepareGuestStructuredSnapshot(snapshot([record('a', 'Full name')]))
    const names = context(prepared, 'Show Full name')
    for (const predicate of [{ field: 'key', equals: 'place:a' }, { field: 'entity', ref: 'n7' }, { field: 'entity', ref: 'n0', equals: 'place:a' }]) expect(() => parseGuestQueryPlan(query([predicate]), prepared, names)).toThrow()
    expect(() => parseGuestQueryPlan(query([{ field: 'entity', ref: 'n0' }]), prepared)).toThrow()
    expect(() => prepared.validateQuery({ tenantId: 'tenant', venueId: 'venue', mode: 'list', predicates: [{ field: 'key', equals: 'canonical:not-a-record' }] })).toThrow(/current scoped/)
  })
  it('rejects duplicate name or alias identities and cross-domain ambiguity rather than selecting first', () => {
    const duplicate = { ...record('b', 'Different title', ['Full name']), key: 'knowledge:b', entityDomain: 'KNOWLEDGE' as const }
    const prepared = prepareGuestStructuredSnapshot(snapshot([record('a', 'Full name'), duplicate]))
    const names = context(prepared, 'Show Full name')
    expect(names.catalog.data.groups[0]).toMatchObject({ candidateCount: 2 })
    expect(names.catalog.data.groups[0]).not.toHaveProperty('record')
    for (const predicate of [{ field: 'entity', ref: 'n0' }, { field: 'name', equals: 'Full name' }]) expect(() => parseGuestQueryPlan(query([predicate]), prepared, names)).toThrow(/ambiguous/)
  })
  it('checks trusted domain and never overrides PLACE with a Knowledge ref, including product seller queries', () => {
    const prepared = prepareGuestStructuredSnapshot(snapshot([{ ...record('a', 'Topic title'), key: 'knowledge:a', entityDomain: 'KNOWLEDGE' }]))
    const names = context(prepared, 'Show Topic title')
    expect(() => parseGuestQueryPlan(query([{ field: 'entity', ref: 'n0' }]), prepared, names)).toThrow(/domain/)
    expect(() => parseGuestQueryPlan(JSON.stringify({ status: 'QUERY', mode: 'list', predicates: [{ field: 'entity', ref: 'n0' }, { field: 'product', name: 'Token' }] }), prepared, names)).toThrow(/domain/)
  })
  it('is source-instance and raw-question bound, resistant to forged catalogs and copied result mutation', () => {
    const value = snapshot([record('a', 'Full name')]), prepared = prepareGuestStructuredSnapshot(value), names = context(prepared, 'Show Full name')
    expect(names.catalog.data.questionSha256).toBe(createHash('sha256').update(names.question).digest('hex'))
    names.catalog.data.groups[0]!.record!.key = 'place:forged'
    expect(prepared.resolveNamedReference(names.catalog, names.question, 'n0')).toBe('place:a')
    expect(() => prepared.namedCatalogData(names.catalog, 'show Full name')).toThrow(/binding/)
    expect(() => prepared.namedCatalogData({ data: names.catalog.data }, names.question)).toThrow(/binding/)
    for (const other of [prepareGuestStructuredSnapshot(value), prepareGuestStructuredSnapshot(snapshot([record('a', 'Changed title')], 'v2'))]) expect(() => other.namedCatalogData(names.catalog, names.question)).toThrow(/binding/)
    value.records[0]!.name = 'Caller changed name'
    expect(prepared.discoverNamedCandidates(names.question).data.groups[0]?.record?.name).toBe('Full name')
    expect(prepareGuestStructuredSnapshot(snapshot([], 'v2')).discoverNamedCandidates(names.question).data.groups).toEqual([])
  })
  it('uses longest enclosing occurrences, preserves separately mentioned short names and rejects crossing overlaps', () => {
    const prepared = prepareGuestStructuredSnapshot(snapshot([record('a', 'North'), record('b', 'North Shop'), record('c', 'Shop Main')]))
    expect(context(prepared, 'Show North Shop').catalog.data.groups.map(g => g.record?.key)).toEqual(['place:b'])
    expect(context(prepared, 'Show North Shop and North').catalog.data.groups.map(g => g.record?.key)).toEqual(['place:b', 'place:a'])
    expect(context(prepared, 'Show North Shop Main').catalog.data).toMatchObject({ status: 'BOUNDED', reason: 'OVERLAPPING_NAMES', groups: [] })
    expect(context(prepared, 'North Shopping').catalog.data.groups.some(g => g.record?.key === 'place:b')).toBe(false)
  })
  it('labels normalized Unicode code-point spans and does not claim original byte offsets', () => {
    const prepared = prepareGuestStructuredSnapshot(snapshot([record('a', '𐐀 Hall'), record('b', 'Flora')]))
    const catalog = context(prepared, '🦊 Show 𐐨 Hall and Ｆｌｏｒａ').catalog.data
    expect(catalog.coordinates).toBe('NORMALIZED_UNICODE_CODEPOINTS')
    expect(catalog.groups.map(g => g.record?.key)).toEqual(['place:a', 'place:b'])
    const normalized = [...'🦊 show 𐐨 hall and flora']
    for (const group of catalog.groups) for (const span of group.normalizedSpans) expect(normalized.slice(span.start, span.end).join('')).toBe(group.normalizedMention)
    expect(context(prepared, 'x𐐨 Hallway').catalog.data.groups).toEqual([])
  })
  it('adds bounded exact catalog data without exposing raw record keys to the model or changing legacy prompt bytes', () => {
    const prepared = prepareGuestStructuredSnapshot(snapshot([record('secret-key', 'Full name')]))
    const before = guestQueryPlanningPrompt(prepared), names = context(prepared, 'Show Full name'), prompt = guestQueryPlanningPrompt(prepared, names)
    expect(prompt).toContain('"ref":"n0"')
    expect(prompt).toContain('"name":"Full name"')
    expect(prompt).not.toContain('place:secret-key')
    expect(prompt.length).toBeLessThanOrEqual(16000)
    expect(guestQueryPlanningPrompt(prepared)).toBe(before)
    expect(prompt).toContain('never drop a conjunct')
    expect(prompt).toContain('Every other actual selection constraint must still be retained and ANDed')
    expect(parseGuestQueryPlan('{"status":"UNSUPPORTED","reason":"age and price selection"}', prepared, names).status).toBe('UNSUPPORTED')
  })
})

describe('bounded lazy named capability', () => {
  it('does not build or normalize the name index for ordinary executor counts; overflow does not poison counts', () => {
    const prepared = prepareGuestStructuredSnapshot(snapshot([record('a', 'Name', Array(MAX_NAMED_INDEX_ENTRIES + 1).fill('Alias'))]))
    const normalize = vi.spyOn(String.prototype, 'normalize')
    try {
      expect(count(prepared)).toBe(1)
      expect(normalize).not.toHaveBeenCalled()
      const catalog = prepared.discoverNamedCandidates('Show Alias')
      expect(catalog.data).toMatchObject({ status: 'BOUNDED', reason: 'NAME_INDEX_BOUND', groups: [] })
      expect(normalize.mock.calls.length).toBeLessThanOrEqual(MAX_NAMED_INDEX_ENTRIES)
      normalize.mockClear()
      expect(prepared.discoverNamedCandidates('Another question').data.status).toBe('BOUNDED')
      expect(normalize).not.toHaveBeenCalled()
      expect(count(prepared)).toBe(1)
      expect(() => parseGuestQueryPlan(query([{ field: 'entity', ref: 'n0' }]), prepared, { question: 'Show Alias', catalog })).toThrow()
      expect(parseGuestQueryPlan(query([{ field: 'kind', equals: 'event' }]), prepared, { question: 'Show Alias', catalog }).status).toBe('QUERY')
    } finally { normalize.mockRestore() }
  })
  it.each(['raw-chars', 'nodes', 'normalized-chars'])('bounds %s before unbounded name normalization/copy', mode => {
    const rows = mode === 'nodes' ? Array.from({ length: 300 }, (_, i) => record(String(i), `Entity ${i} ${'x'.repeat(1000)}`)) : [record('a', 'Name', mode === 'raw-chars' ? Array(2100).fill('x'.repeat(1024)) : Array(60).fill('\ufdfa'.repeat(2048)))]
    const prepared = prepareGuestStructuredSnapshot(snapshot(rows))
    expect(prepared.discoverNamedCandidates('Show Name').data).toMatchObject({ status: 'BOUNDED', reason: 'NAME_INDEX_BOUND', groups: [] })
    expect(count(prepared)).toBe(rows.length)
  })
  it.each(['hit', 'group', 'span', 'chars', 'work', 'question-normalization'])('exposes %s overflow without partial name authority', mode => {
    const rows = mode === 'group' ? Array.from({ length: 9 }, (_, i) => record(String(i), `Unique ${i}`)) : mode === 'chars' ? [record('a', 'A'.repeat(1100)), record('b', 'B'.repeat(1100))] : [record('a', mode === 'work' ? 'A '.repeat(1000) + 'Z' : 'Name')]
    const question = mode === 'group' ? rows.map(r => r.name).join(' and ') : mode === 'chars' ? rows.map(r => r.name).join(' and ') : mode === 'work' ? 'A '.repeat(8000) : mode === 'question-normalization' ? '\ufdfa'.repeat(16000) : Array(mode === 'hit' ? 65 : 9).fill('Name').join(' ')
    const prepared = prepareGuestStructuredSnapshot(snapshot(rows)), catalog = prepared.discoverNamedCandidates(question)
    expect(catalog.data).toMatchObject({ status: 'BOUNDED', groups: [] })
    expect(count(prepared)).toBe(rows.length)
    expect(() => prepared.resolveNamedReference(catalog, question, 'n0')).toThrow()
  })
  it('retains exact late-name lookup across 10000 current records with bounded planner catalog', () => {
    const rows = Array.from({ length: 10000 }, (_, i) => record(String(i), `Meadow Habitat event ${String(i).padStart(5, '0')}`))
    const prepared = prepareGuestStructuredSnapshot(snapshot(rows)), names = context(prepared, 'Quote conditions for Meadow Habitat event 09999.')
    expect(names.catalog.data.groups).toHaveLength(1)
    const plan = parseGuestQueryPlan(query([{ field: 'entity', ref: 'n0' }, { field: 'kind', equals: 'event' }, { field: 'area', equals: 'Meadow Habitat' }]), prepared, names)
    if (plan.status !== 'QUERY') throw Error('Expected query')
    expect(prepared.evaluate(plan.query).page().matchingKeys).toEqual(['place:9999'])
    expect(guestQueryPlanningPrompt(prepared, names).length).toBeLessThanOrEqual(16000)
  })
  it('reserves prompt space for the catalog while explicitly truncating large vocabularies', () => {
    const rows = Array.from({ length: 100 }, (_, i) => {
      const row = record(String(i), `Entity ${i}`)
      row.kind = { state: 'KNOWN', value: `KIND_${i}_${'k'.repeat(500)}`, sources: [{ sourceKey: row.key, fieldPath: 'kind' }] }
      row.area = { state: 'KNOWN', value: `AREA_${i}_${'a'.repeat(500)}`, sources: [{ sourceKey: row.key, fieldPath: 'area' }] }
      row.features = { [`feature_${i}_${'f'.repeat(50)}`]: { state: 'UNKNOWN' } }
      return row
    })
    const prepared = prepareGuestStructuredSnapshot(snapshot(rows)), names = context(prepared, 'Show Entity 99.')
    const prompt = guestQueryPlanningPrompt(prepared, names)
    expect(prompt.length).toBeLessThanOrEqual(16000)
    expect(prompt).toContain('"name":"Entity 99"')
    expect(prompt).toContain('"truncated":true')
    expect(prompt).toContain('Non-name queries remain supported when name capability is bounded')
  })
})
