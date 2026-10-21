import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  compileGuestQueryCanonicalSource,
  GUEST_QUERY_CANONICAL_COMPILER_CONTRACT,
} from './guest-query-canonical-projection'
import { parseGuestQueryPlan } from './guest-query-planning'
import { formatGuestQueryDirectAnswer } from './guest-query-direct-answer'
import { renderGuestQueryResult } from './guest-query-result-prompt'
import type { GuestQuerySource } from './guest-query-source'
import {
  executeGuestStructuredQuery as execute,
  type GuestStructuredQuery,
  type GuestStructuredSnapshot,
} from './guest-structured-query'

function source(topics = 100): GuestQuerySource {
  const clock = '2026-10-21T05:00:00.000Z'
  const payloads = [
    { kind: 'SERVICE' as const, name: 'Counter', placeId: 'seller' },
    { kind: 'ITEM' as const, name: 'Dots', itemType: 'PRODUCT' },
    {
      kind: 'RELATIONSHIP' as const,
      fromModuleId: 'm0',
      toModuleId: 'm1',
      relationshipType: 'OFFERS_PRODUCT_V1',
    },
  ]
  return {
    tenantId: 't',
    venueId: 'v',
    version: 'source-v1',
    asOf: clock,
    readPath: 'LEGACY',
    includeSecondLayer: false,
    coverage: 'COMPLETE',
    directory: {
      searchVersion: 'source-v1',
      incomplete: false,
      places: ['seller', 'other', 'unknown'].map((id, i) => ({
        id,
        name: id,
        type: i === 0 ? 'FOOD' : 'SHOP',
        itemType: null,
        shortDescription: null,
        longDescription: null,
        lat: null,
        lng: null,
        tags: [],
        areaName: null,
        hours: null,
        photoUrl: null,
        sourceType: 'MANUAL',
        sourceName: null,
        sourceUrl: null,
      })),
      knowledge: Array.from({ length: topics }, (_, i) => ({
        id: `topic-${i}`,
        title: `Policy ${i}`,
        category: 'POLICY',
        content: 'Policy only; original conditions preserved.',
        sourceType: 'MANUAL',
        sourceName: null,
        sourceUrl: null,
      })),
    },
    canonicalModules: {
      contract: 'published-query-source-v1',
      modules: payloads.map((payload, i) => ({
        moduleId: `m${i}`,
        revisionId: `r${i}`,
        publicationId: `p${i}`,
        publicationOrder: String(i + 1),
        version: 1,
        kind: payload.kind,
        payload,
        audience: 'PUBLIC',
        effectiveFrom: null,
        effectiveUntil: null,
        evidence: [],
      })),
    },
  }
}
const q = (domain?: GuestStructuredQuery['domain']): GuestStructuredQuery => ({
  tenantId: 't',
  venueId: 'v',
  mode: 'count',
  ...(domain ? { domain } : {}),
  predicates: [{ field: 'product', name: 'Dots' }],
})

describe('governed entity domains', () => {
  it('product planner selects every place kind but excludes knowledge from candidate unknowns', () => {
    const compiled = compileGuestQueryCanonicalSource(source())
    const plan = parseGuestQueryPlan(
      JSON.stringify({ status: 'QUERY', mode: 'count', predicates: q().predicates }),
      compiled.prepared,
    )
    if (plan.status !== 'QUERY') throw Error('Expected query')
    expect(plan.query.domain).toBe('PLACE')
    expect(compiled.prepared.evaluate(plan.query).page()).toMatchObject({
      domain: 'PLACE',
      candidateCount: 3,
      knownMatchCount: 1,
      unknownCandidateCount: 2,
      exactEligibleCount: null,
    })
    expect(compiled.prepared.evaluate(q()).page()).toMatchObject({
      domain: 'ALL',
      candidateCount: 103,
      knownMatchCount: 1,
      unknownCandidateCount: 102,
    })
    expect(compiled.snapshot.records.find((r) => r.key === 'place:seller')?.entityDomain).toBe(
      'PLACE',
    )
    expect(compiled.snapshot.records.find((r) => r.key === 'knowledge:topic-0')?.entityDomain).toBe(
      'KNOWLEDGE',
    )
  })
  it('keeps general default ALL and explicit knowledge name selection', () => {
    const compiled = compileGuestQueryCanonicalSource(source())
    expect(compiled.prepared.evaluate({ ...q(), predicates: [] }).page()).toMatchObject({
      domain: 'ALL',
      candidateCount: 103,
      knownMatchCount: 103,
    })
    expect(
      compiled.prepared
        .evaluate({ ...q('KNOWLEDGE'), predicates: [{ field: 'name', equals: 'Policy 99' }] })
        .page(),
    ).toMatchObject({ candidateCount: 100, knownMatchCount: 1, unknownCandidateCount: 0 })
  })
  it('rejects knowledge product conjunctions and invalid domains', () => {
    const compiled = compileGuestQueryCanonicalSource(source())
    expect(() => compiled.prepared.evaluate(q('KNOWLEDGE'))).toThrow(/seller domain/)
    for (const domain of ['KNOWLEDGE', 'BOGUS'])
      expect(() =>
        parseGuestQueryPlan(
          JSON.stringify({ status: 'QUERY', mode: 'count', domain, predicates: q().predicates }),
          compiled.prepared,
        ),
      ).toThrow(/domain/)
    expect(() => compiled.prepared.evaluate({ ...q(), domain: 'place' })).toThrow(/domain/)
  })
  it('preserves untagged pure fixtures and their historical absent-domain query hashes', () => {
    const compiled = compileGuestQueryCanonicalSource(source(1))
    const legacy: GuestStructuredSnapshot = {
      ...compiled.snapshot,
      records: compiled.snapshot.records.map((record) => {
        const r = { ...record }
        delete r.entityDomain
        return r
      }),
    }
    const result = execute(legacy, q())
    expect(result).toMatchObject({
      domain: 'ALL',
      candidateCount: 4,
      knownMatchCount: 1,
      unknownCandidateCount: 3,
    })
    expect(execute(legacy, q('ALL')).matchingKeys).toEqual(result.matchingKeys)
    expect(() => execute(legacy, q('PLACE'))).toThrow(/trusted record domains/)
    const canonical = JSON.stringify({
      mode: 'count',
      predicates: [{ field: 'product', name: 'Dots' }],
      tenantId: 't',
      venueId: 'v',
    })
    expect(result.queryIdentity).toBe(createHash('sha256').update(canonical).digest('hex'))
  })
  it('rejects invalid record domains and untagged mixed membership for explicit scopes', () => {
    const compiled = compileGuestQueryCanonicalSource(source(0))
    const mixed = structuredClone(compiled.snapshot)
    delete mixed.records[0]!.entityDomain
    expect(() => execute(mixed, q('PLACE'))).toThrow(/trusted record domains/)
    expect(() =>
      execute({ ...mixed, records: [{ ...mixed.records[0]!, entityDomain: 'ALL' }] } as never, q()),
    ).toThrow(/entity domain/)
  })
  it('binds pagination to explicit domain and newly tagged snapshot semantics', () => {
    const compiled = compileGuestQueryCanonicalSource(source(1))
    const query = { ...q('ALL'), mode: 'list' as const, predicates: [] }
    const first = compiled.prepared.evaluate(query).page({ pageSize: 1 })
    expect(() =>
      compiled.prepared.evaluate({ ...query, domain: 'PLACE' }).page({ cursor: first.nextCursor! }),
    ).toThrow(/changed/)
    const legacy = {
      ...compiled.snapshot,
      records: compiled.snapshot.records.map((record) => {
        const r = { ...record }
        delete r.entityDomain
        return r
      }),
    }
    const generic = { ...q(), mode: 'list' as const, predicates: [] }
    const prior = execute(legacy, generic, { pageSize: 1 })
    expect(() => execute(compiled.snapshot, generic, { cursor: prior.nextCursor! })).toThrow(
      /changed/,
    )
    expect(compiled.contract).toBe(GUEST_QUERY_CANONICAL_COMPILER_CONTRACT)
    expect(compiled.contract).not.toBe('guest-query-canonical-v1')
  })
  it('exposes candidate scope in aggregate, list and direct receipts while retaining knowledge conditions', () => {
    const value = source(1),
      compiled = compileGuestQueryCanonicalSource(value)
    for (const mode of ['count', 'list'] as const) {
      const query = { ...q('PLACE'), mode },
        result = compiled.prepared.evaluate(query).page()
      const direct = formatGuestQueryDirectAnswer({ source: value, compiled, query })
      expect(direct.status).toBe('READY')
      if (direct.status !== 'READY') throw Error(direct.reason)
      expect(direct.receipt).toMatchObject({
        domain: 'PLACE',
        candidateCount: 3,
        domainContract: 'guest-query-domain-v1',
      })
      if (mode === 'list') expect(direct.answer).toContain(value.directory.knowledge[0]!.content)
      const rendered = renderGuestQueryResult({ result, sources: [] })
      const data = JSON.parse(rendered.prompt.slice(rendered.prompt.lastIndexOf('\n') + 1))
      expect(data).toMatchObject({ domain: 'PLACE', candidateCount: 3 })
    }
  })
})
