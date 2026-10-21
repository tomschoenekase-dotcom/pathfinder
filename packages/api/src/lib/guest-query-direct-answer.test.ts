import { describe, expect, it, vi } from 'vitest'
import type { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'
import { legacyGuestResponseToBlocks } from '@pathfinder/contracts/guest-response'
import { compileGuestQueryCanonicalSource } from './guest-query-canonical-projection'
import { formatGuestQueryDirectAnswer } from './guest-query-direct-answer'
import type { GuestQuerySource } from './guest-query-source'
import type { GuestStructuredQuery, PreparedGuestQuery } from './guest-structured-query'

function source(size = 1): GuestQuerySource {
  return {
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    version: 'v1',
    asOf: '2026-10-21T05:00:00.000Z',
    readPath: 'LEGACY',
    includeSecondLayer: false,
    coverage: 'COMPLETE',
    directory: {
      searchVersion: 'v1',
      incomplete: false,
      places: Array.from({ length: size }, (_, i) => ({
        id: `shop-${String(i).padStart(3, '0')}`,
        name: `Shop ${i}`,
        type: 'SHOP',
        itemType: null,
        shortDescription: null,
        longDescription: `Whole description for shop ${i}; under ten requires an adult.`,
        areaName: `Area ${i}`,
        hours: null,
        lat: null,
        lng: null,
        tags: [],
        photoUrl: null,
        sourceType: 'MANUAL',
        sourceName: null,
        sourceUrl: null,
      })),
      knowledge: [],
    },
  }
}
const query = (mode: 'count' | 'list' = 'list'): GuestStructuredQuery => ({
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  mode,
  predicates: [{ field: 'kind', equals: 'SHOP' }],
})
function render(value: GuestQuerySource, q = query()) {
  return formatGuestQueryDirectAnswer({
    source: value,
    compiled: compileGuestQueryCanonicalSource(value),
    query: q,
  })
}
function products() {
  const value = source(4)
  const rows: Array<{ id: string; payload: GeneralizedContentPayload }> = [
    {
      id: 'product-private-id',
      payload: {
        kind: 'ITEM',
        name: 'Sketch kit',
        itemType: 'PRODUCT',
        description: 'Each kit costs $8. Equipment is sold separately.',
      },
    },
  ]
  for (let i = 0; i < 3; i++) {
    rows.push({
      id: `service-private-${i}`,
      payload: {
        kind: 'SERVICE',
        name: `Counter ${i}`,
        placeId: value.directory.places[i]!.id,
        description: `Counter ${i} requires a paid ticket.`,
        availability: `Counter ${i}: weekends only; closed during storms.`,
      },
    })
    rows.push({
      id: `offer-private-${i}`,
      payload: {
        kind: 'RELATIONSHIP',
        fromModuleId: `service-private-${i}`,
        toModuleId: 'product-private-id',
        relationshipType: 'OFFERS_PRODUCT_V1',
      },
    })
  }
  rows.push(
    {
      id: 'base-private',
      payload: {
        kind: 'POLICY',
        title: 'Kit purchase',
        rule: 'Each visitor pays $8. No refunds. Under ten requires a paying adult.',
        appliesTo: ['service-private-0', 'service-private-1', 'service-private-2'],
      },
    },
    {
      id: 'exception-private',
      payload: {
        kind: 'POLICY',
        title: 'Tuesday member exception',
        rule: 'On Tuesdays only, members pay $4. Adult accompaniment still applies.',
        appliesTo: ['service-private-1'],
      },
    },
    {
      id: 'exception-edge-private',
      payload: {
        kind: 'RELATIONSHIP',
        fromModuleId: 'exception-private',
        toModuleId: 'base-private',
        relationshipType: 'EXCEPTION_TO_V1',
      },
    },
  )
  value.canonicalModules = {
    contract: 'published-query-source-v1',
    modules: rows.map(({ id, payload }, i) => ({
      moduleId: id,
      revisionId: `rev-${id}`,
      publicationId: `pub-${id}`,
      publicationOrder: String(i + 1),
      kind: payload.kind,
      version: 1,
      payload,
      audience: 'PUBLIC',
      effectiveFrom: null,
      effectiveUntil: null,
      evidence: [
        {
          sourceId: 'operator-evidence-private',
          locator: 'page 2',
          capturedAt: value.asOf,
          excerptHash: null,
        },
      ],
    })),
  }
  return value
}
const productQuery: GuestStructuredQuery = {
  ...query(),
  predicates: [{ field: 'product', name: 'Sketch kit' }],
}

describe('deterministic direct stored-query answers', () => {
  it('uses actual pagination to preserve all 53 names, areas and whole visible descriptions', () => {
    const value = source(53)
    const compiled = compileGuestQueryCanonicalSource(value)
    const evaluate = vi.spyOn(Object.getPrototypeOf(compiled.prepared), 'evaluate')
    try {
      const output = formatGuestQueryDirectAnswer({ source: value, compiled, query: query() })
      if (output.status !== 'READY') throw new Error(output.reason)
      expect(evaluate).toHaveBeenCalledOnce()
      expect(output.result.rows).toHaveLength(53)
      expect(output.result.hasMore).toBe(false)
      expect(output.receipt).toMatchObject({
        mode: 'list',
        returnedCount: 53,
        completeKnownSet: true,
        retainedSourceCount: 53,
      })
      for (const place of value.directory.places) {
        expect(output.answer).toContain(`${place.name} (${place.areaName})`)
        expect(output.answer).toContain(place.longDescription)
      }
      expect(output.places).toEqual(value.directory.places)
      expect(output.retainedKeys).toEqual(output.result.matchingKeys)
    } finally {
      evaluate.mockRestore()
    }
  })
  it('lists all three actual product locations and exact scoped policy/exception bodies with unknowns', () => {
    const value = products()
    const output = render(value, productQuery)
    if (output.status !== 'READY') throw new Error(output.reason)
    expect(output.result.knownMatchCount).toBe(3)
    expect(output.result.unknownCandidateCount).toBe(1)
    expect(output.result.exactEligibleCount).toBeNull()
    expect(output.answer).toContain('An exact total is not available')
    for (let i = 0; i < 3; i++) expect(output.answer).toContain(`Shop ${i} (Area ${i})`)
    expect(output.answer).not.toContain('Shop 3')
    expect(output.answer).toContain(
      'Each visitor pays $8. No refunds. Under ten requires a paying adult.',
    )
    expect(output.answer).toContain(
      'On Tuesdays only, members pay $4. Adult accompaniment still applies.',
    )
    expect(output.answer).toContain('Applies to: service "Counter 1" at Shop 1.')
    expect(output.answer).toContain(
      'Exception link: rule "Tuesday member exception" -> rule "Kit purchase".',
    )
    expect(output.answer).toContain('Counter 2: weekends only; closed during storms.')
    expect(output.answer).not.toContain('private')
    expect(output.answer).not.toContain('OFFERS_PRODUCT_V1')
    expect(output.answer).not.toContain('EXCEPTION_TO_V1')
    expect(output.answer).not.toContain('"payload"')
    expect(
      output.canonicalSources.every((row) =>
        value.canonicalModules!.modules.some((actual) => JSON.stringify(actual) === row.text),
      ),
    ).toBe(true)
  })
  it('count returns complete numeric membership without descriptions or invented negative stock', () => {
    const exact = render(source(501), query('count'))
    if (exact.status !== 'READY') throw new Error(exact.reason)
    expect(exact.answer).toContain('501 matching listed entries')
    expect(exact.answer).not.toContain('Whole description')
    expect(exact.places).toEqual([])
    expect(exact.knowledge).toEqual([])
    expect(exact.canonicalSources).toEqual([])
    const unknown = render(products(), { ...productQuery, mode: 'count' })
    if (unknown.status !== 'READY') throw new Error(unknown.reason)
    expect(unknown.answer).toContain('3 confirmed matching listed entries')
    expect(unknown.answer).toContain('1 other listed entry has unknown matching status')
    expect(unknown.answer).toContain('An exact total is not available')
    expect(unknown.answer).not.toContain('No refunds')
    expect(unknown.receipt.exactEligibleCount).toBeNull()
  })
  it('retains every legacy topic whole with its stated scope without asserting universal applicability', () => {
    const value = source()
    value.directory.knowledge.push({
      id: 'topic',
      title: 'Theater only',
      category: 'POLICY',
      content: 'Theater only: no late entry. This does not apply to shops.',
      sourceType: 'MANUAL',
      sourceName: null,
      sourceUrl: null,
    })
    const output = render(value)
    if (output.status !== 'READY') throw new Error(output.reason)
    expect(output.answer).toContain(value.directory.knowledge[0]!.content)
    expect(output.answer).toContain('only applies where its text says')
    expect(output.knowledge).toEqual(value.directory.knowledge)
  })
  it('selected knowledge is retained exactly once instead of copied into a phantom place', () => {
    const value = source(0)
    value.directory.knowledge.push({
      id: 'topic',
      title: 'Museum entry',
      category: 'POLICY',
      content: 'Under ten needs a paying adult. No exception on weekends.',
      sourceType: 'MANUAL',
      sourceName: null,
      sourceUrl: null,
    })
    const output = render(value, {
      ...query(),
      predicates: [{ field: 'kind', equals: 'KNOWLEDGE' }],
    })
    if (output.status !== 'READY') throw new Error(output.reason)
    expect(output.places).toEqual([])
    expect(output.knowledge).toEqual(value.directory.knowledge)
    expect(output.answer.split(value.directory.knowledge[0]!.content)).toHaveLength(2)
  })
  it.each([201, 501])(
    'declines %s complete matches instead of returning a complete-looking truncated list',
    (size) => {
      const output = render(source(size))
      expect(output).toMatchObject({ status: 'UNSUPPORTED', reason: 'RESULT_BOUND' })
      expect(output).not.toHaveProperty('answer')
    },
  )
  it('declines a whole oversized body rather than cutting away its final condition', () => {
    const value = source()
    value.directory.places[0]!.longDescription =
      'BEGIN ' + 'x'.repeat(30_000) + ' END unless an adult pays.'
    expect(render(value)).toMatchObject({ status: 'UNSUPPORTED', reason: 'ANSWER_BOUND' })
  })
  it.each(['bad\u0000body', 'bad\u202ebody', '[[button:buy-now]]', '[[ENGAGEMENT_ASKED]]'])(
    'declines unsafe source text %j without rendering actions',
    (body) => {
      const value = source()
      value.directory.places[0]!.longDescription = body
      expect(render(value)).toMatchObject({ status: 'UNSUPPORTED', reason: 'UNSAFE_TEXT' })
    },
  )
  it('preserves exact punctuation in plain React text blocks without interpreting source markup or links', () => {
    const value = source()
    value.directory.places[0]!.longDescription =
      '[Book](https://example.invalid) <script>alert(1)</script> **Adults only**'
    const output = render(value)
    if (output.status !== 'READY') throw new Error(output.reason)
    expect(output.answer).toContain(value.directory.places[0]!.longDescription)
    expect(output.answer).not.toContain('\\[')
    expect(output.answer).not.toContain('\\.')
    expect(output.receipt.textFormat).toBe('PLAIN_TEXT')
    const blocks = legacyGuestResponseToBlocks({ content: output.answer })
    expect(blocks).toEqual([{ type: 'text', text: output.answer }])
    expect(blocks[0]).not.toHaveProperty('links')
  })
  it('declines when whole retained sources would exceed the 99-source allowance', () => {
    expect(render(source(100))).toMatchObject({ status: 'UNSUPPORTED', reason: 'SOURCE_BOUND' })
  })
  it('rejects source scope/version/clock mismatches against the actual private prepared handle', () => {
    const value = source()
    const compiled = compileGuestQueryCanonicalSource(value)
    for (const other of [
      { ...value, version: 'changed' },
      { ...value, venueId: 'other' },
      { ...value, asOf: '2026-10-22T05:00:00.000Z' },
    ])
      expect(
        formatGuestQueryDirectAnswer({ source: other, compiled, query: query() }),
      ).toMatchObject({ status: 'UNSUPPORTED', reason: 'SOURCE_MISMATCH' })
    expect(
      formatGuestQueryDirectAnswer({
        source: value,
        compiled,
        query: { ...query(), tenantId: 'other' },
      }),
    ).toMatchObject({ status: 'UNSUPPORTED', reason: 'SOURCE_MISMATCH' })
  })
  it('detects inconsistent metadata across actual pagination instead of claiming the list is complete', () => {
    const value = source(53)
    const compiled = compileGuestQueryCanonicalSource(value)
    const exemplar = compiled.prepared.evaluate(query())
    const prototype = Object.getPrototypeOf(exemplar) as PreparedGuestQuery
    const original = prototype.page.bind(exemplar)
    const page = vi.spyOn(prototype, 'page').mockImplementation((options) => {
      const result = original(options)
      return options?.cursor ? { ...result, knownMatchCount: 54 } : result
    })
    try {
      expect(
        formatGuestQueryDirectAnswer({ source: value, compiled, query: query() }),
      ).toMatchObject({ status: 'UNSUPPORTED', reason: 'PAGINATION_MISMATCH' })
    } finally {
      page.mockRestore()
    }
  })
  it('declines unsupported feature/product authority and mismatched canonical body identities', () => {
    expect(
      render(source(), {
        ...query(),
        predicates: [{ field: 'feature', name: 'eligible', value: true }],
      }),
    ).toMatchObject({ status: 'UNSUPPORTED', reason: 'UNSUPPORTED_QUERY' })
    expect(render(source(), productQuery)).toMatchObject({
      status: 'UNSUPPORTED',
      reason: 'UNSUPPORTED_QUERY',
    })
    const value = products()
    const compiled = compileGuestQueryCanonicalSource(value)
    compiled.canonicalSources[0]!.text = 'different body'
    expect(
      formatGuestQueryDirectAnswer({ source: value, compiled, query: productQuery }),
    ).toMatchObject({ status: 'UNSUPPORTED', reason: 'SOURCE_MISMATCH' })
  })
})
