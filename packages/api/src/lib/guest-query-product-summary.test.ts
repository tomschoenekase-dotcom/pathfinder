import { describe, expect, it } from 'vitest'
import type { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'
import type { GuestQuerySource } from './guest-query-source'
import { compileGuestQueryCanonicalSource } from './guest-query-canonical-projection'
import { formatGuestQueryDirectAnswer } from './guest-query-direct-answer'
import { prepareGuestStructuredSnapshot } from './guest-structured-query'

function fixture(names = ['Amber token', 'Blue token'], duplicateOffer = false): GuestQuerySource {
  const source: GuestQuerySource = {
    tenantId: 'tenant-dev',
    venueId: 'venue-dev',
    version: 'dev-v1',
    asOf: '2026-10-21T05:00:00Z',
    readPath: 'LEGACY',
    includeSecondLayer: false,
    coverage: 'COMPLETE',
    directory: {
      searchVersion: 'dev-v1',
      incomplete: false,
      knowledge: [],
      places: [
        {
          id: 'counter',
          name: 'Fictional Counter',
          type: 'SHOP',
          itemType: null,
          shortDescription: null,
          longDescription: 'Children need an adult. Bring booking confirmation.',
          areaName: null,
          hours: null,
          lat: null,
          lng: null,
          tags: [],
          photoUrl: null,
          sourceType: 'MANUAL',
          sourceName: null,
          sourceUrl: null,
        },
      ],
    },
  }
  const modules: Array<{ id: string; payload: GeneralizedContentPayload }> = [
    {
      id: 'service',
      payload: {
        kind: 'SERVICE',
        name: 'Counter service',
        placeId: 'counter',
        availability: 'Weekends only; closed during storms.',
      },
    },
    {
      id: 'policy',
      payload: {
        kind: 'POLICY',
        title: 'Purchase conditions',
        rule: 'Each visitor pays $8. No refunds. Members still book ahead.',
        appliesTo: ['service'],
      },
    },
  ]
  for (const [i, name] of names.entries())
    modules.push(
      {
        id: `product-${i}`,
        payload: {
          kind: 'ITEM',
          itemType: 'PRODUCT',
          name,
          description: `Full product ${i} conditions. No exchanges.`,
        },
      },
      {
        id: `offer-${i}`,
        payload: {
          kind: 'RELATIONSHIP',
          fromModuleId: 'service',
          toModuleId: `product-${i}`,
          relationshipType: 'OFFERS_PRODUCT_V1',
        },
      },
    )
  if (duplicateOffer)
    modules.push({
      id: 'offer-duplicate',
      payload: {
        kind: 'RELATIONSHIP',
        fromModuleId: 'service',
        toModuleId: 'product-0',
        relationshipType: 'OFFERS_PRODUCT_V1',
      },
    })
  source.canonicalModules = {
    contract: 'published-query-source-v1',
    modules: modules.map(({ id, payload }, i) => ({
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
          sourceId: 'synthetic-owner',
          locator: 'conditions',
          capturedAt: source.asOf,
          excerptHash: null,
        },
      ],
    })),
  }
  return source
}
function render(
  source: GuestQuerySource,
  domain: 'PLACE' | 'KNOWLEDGE' | 'ALL' = 'PLACE',
  mode: 'count' | 'list' = 'list',
) {
  return formatGuestQueryDirectAnswer({
    source,
    compiled: compileGuestQueryCanonicalSource(source),
    query: {
      tenantId: source.tenantId,
      venueId: source.venueId,
      domain,
      mode,
      predicates: [{ field: 'name', equals: 'Fictional Counter' }],
    },
  })
}
describe('explicit record units and positive-only per-place product names', () => {
  it('distinguishes one place from two confirmed product names and retains whole source conditions', () => {
    const source = fixture()
    const output = render(source)
    if (output.status !== 'READY') throw Error(output.reason)
    expect(output.answer).toContain('1 matching listed place.')
    expect(output.answer).toContain(
      '2 confirmed distinct listed product names: "Amber token"; "Blue token".',
    )
    expect(output.answer).toContain(
      'not an exhaustive product inventory or a live availability check',
    )
    expect(output.receipt).toMatchObject({
      formatterVersion: 'guest-query-direct-answer-v3',
      recordCountUnit: 'place',
      knownMatchCount: 1,
    })
    for (const text of [
      'Children need an adult. Bring booking confirmation.',
      'Weekends only; closed during storms.',
      'Each visitor pays $8. No refunds. Members still book ahead.',
      'Full product 0 conditions. No exchanges.',
      'Full product 1 conditions. No exchanges.',
    ])
      expect(output.answer).toContain(text)
    expect(output.canonicalSources).toHaveLength(6)
    expect(output.canonicalSources.every((body) => output.retainedKeys.includes(body.key))).toBe(
      true,
    )
  })
  it('does not double-count duplicate offer edges', () => {
    const output = render(fixture(undefined, true))
    if (output.status !== 'READY') throw Error(output.reason)
    expect(output.answer).toContain('2 confirmed distinct listed product names:')
    expect(output.answer).not.toContain('3 confirmed distinct')
  })
  it.each([{ names: [] }, { names: ['Amber token', '  AMBER  token '] }])(
    'never presents absent or ambiguous product inventory as zero: %j',
    ({ names }) => {
      const output = render(fixture(names))
      if (output.status !== 'READY') throw Error(output.reason)
      expect(output.answer).toContain('Listed product names/count: unknown')
      expect(output.answer).not.toContain('0 confirmed distinct')
      expect(output.answer).not.toContain('2 confirmed distinct')
    },
  )
  it('keeps known positive names while ambiguous other names remain uncounted, with no exhaustive total', () => {
    const output = render(fixture(['Amber token', 'Blue token', ' BLUE token ']))
    if (output.status !== 'READY') throw Error(output.reason)
    expect(output.answer).toContain('1 confirmed distinct listed product name: "Amber token".')
    expect(output.answer).toContain('not an exhaustive product inventory')
  })
  it('count mode counts places only and does not suggest a product aggregate', () => {
    const output = render(fixture(), 'PLACE', 'count')
    if (output.status !== 'READY') throw Error(output.reason)
    expect(output.answer).toContain('1 matching listed place.')
    expect(output.answer).not.toContain('confirmed distinct listed product')
    expect(output.canonicalSources).toEqual([])
  })
  it('labels ALL as records and KNOWLEDGE as knowledge topics', () => {
    const source = fixture([])
    source.directory.knowledge = [
      {
        id: 'topic',
        title: 'Fictional Counter',
        category: 'Guide',
        content: 'Full knowledge body.',
        sourceType: 'MANUAL',
        sourceName: null,
        sourceUrl: null,
      },
    ]
    const all = render(source, 'ALL', 'count')
    const knowledge = render(source, 'KNOWLEDGE', 'count')
    if (all.status !== 'READY' || knowledge.status !== 'READY') throw Error('unexpected decline')
    expect(all.answer).toContain('2 matching listed records.')
    expect(knowledge.answer).toContain('1 matching listed knowledge topic.')
  })
  it('does not turn conflicting private prepared products into an exact zero', () => {
    const source = fixture([])
    const compiled = compileGuestQueryCanonicalSource(source)
    const snapshot = structuredClone(compiled.snapshot)
    snapshot.records[0]!.products = {
      state: 'CONFLICTING',
      sources: [{ sourceKey: 'place:counter', fieldPath: 'name' }],
    }
    compiled.prepared = prepareGuestStructuredSnapshot(snapshot)
    const output = formatGuestQueryDirectAnswer({
      source,
      compiled,
      query: {
        tenantId: source.tenantId,
        venueId: source.venueId,
        domain: 'PLACE',
        mode: 'list',
        predicates: [{ field: 'name', equals: 'Fictional Counter' }],
      },
    })
    if (output.status !== 'READY') throw Error(output.reason)
    expect(output.answer).toContain('Listed product names/count: unknown')
    expect(output.answer).not.toContain('0 confirmed distinct')
  })
  it('rejects a summary whose proof no longer has the same retained source authority', () => {
    const source = fixture()
    const compiled = compileGuestQueryCanonicalSource(source)
    compiled.relatedKeysByPlace['place:counter'] = compiled.relatedKeysByPlace[
      'place:counter'
    ]!.filter((k) => k !== 'canonical:rev-offer-0')
    expect(
      formatGuestQueryDirectAnswer({
        source,
        compiled,
        query: {
          tenantId: source.tenantId,
          venueId: source.venueId,
          domain: 'PLACE',
          mode: 'list',
          predicates: [{ field: 'name', equals: 'Fictional Counter' }],
        },
      }),
    ).toMatchObject({ status: 'UNSUPPORTED', reason: 'SOURCE_MISMATCH' })
  })
  it('counts summary text toward the same whole-answer10k bound', () => {
    const source = fixture()
    const baseline = render(source)
    if (baseline.status !== 'READY') throw Error(baseline.reason)
    source.directory.places[0]!.longDescription += 'x'.repeat(10000 - baseline.answer.length)
    const exact = render(source)
    if (exact.status !== 'READY') throw Error(exact.reason)
    expect(exact.answer).toHaveLength(10000)
    source.directory.places[0]!.longDescription += 'x'
    expect(render(source)).toMatchObject({ status: 'UNSUPPORTED', reason: 'ANSWER_BOUND' })
  })
})
