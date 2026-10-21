import { describe, expect, it } from 'vitest'
import type { EffectivePublishedUniversalContentSnapshot } from '@pathfinder/db'
import type { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'
import { compileGuestQueryCanonicalSource } from './guest-query-canonical-projection'
import type { GuestQuerySource } from './guest-query-source'

const clock = '2026-10-21T05:00:00.000Z'
function module(
  id: string,
  payload: GeneralizedContentPayload,
): EffectivePublishedUniversalContentSnapshot {
  return {
    moduleId: id,
    revisionId: `rev-${id}`,
    publicationId: `pub-${id}`,
    publicationOrder: '1',
    version: 1,
    kind: payload.kind,
    payload,
    audience: 'PUBLIC',
    effectiveFrom: null,
    effectiveUntil: null,
    evidence: [
      {
        sourceId: 'operator-document',
        locator: 'page 2',
        capturedAt: clock,
        excerptHash: 'a'.repeat(64),
      },
    ],
  }
}
function fixture(family = 'museum'): GuestQuerySource {
  return {
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    asOf: clock,
    version: 'admitted-v1',
    readPath: 'LEGACY',
    includeSecondLayer: false,
    coverage: 'COMPLETE',
    directory: {
      searchVersion: 'admitted-v1',
      incomplete: false,
      places: [
        {
          id: 'seller',
          name: `${family} shop`,
          type: 'SHOP',
          itemType: null,
          shortDescription: null,
          longDescription: 'Whole place condition: visitors under ten require an adult.',
          lat: null,
          lng: null,
          tags: [],
          areaName: 'North',
          hours: null,
          photoUrl: null,
          sourceType: 'MANUAL',
          sourceName: null,
          sourceUrl: null,
        },
      ],
      knowledge: [],
    },
    canonicalModules: {
      contract: 'published-query-source-v1',
      modules: [
        module('seller-module', {
          kind: 'SERVICE',
          name: `${family} counter`,
          placeId: 'seller',
          availability: 'Weekends only',
        }),
        module('product', {
          kind: 'ITEM',
          name: `${family} token`,
          itemType: 'PRODUCT',
          description: 'Not transferable',
        }),
        module('offer', {
          kind: 'RELATIONSHIP',
          fromModuleId: 'seller-module',
          toModuleId: 'product',
          relationshipType: 'OFFERS_PRODUCT_V1',
        }),
        module('base-policy', {
          kind: 'POLICY',
          title: 'Purchase rule',
          rule: 'Each visitor pays $8. No refunds.',
          appliesTo: ['seller-module'],
        }),
        module('exception', {
          kind: 'POLICY',
          title: 'Tuesday exception',
          rule: 'On Tuesdays only, members pay $4. Adult rule still applies.',
          appliesTo: [],
        }),
        module('exception-edge', {
          kind: 'RELATIONSHIP',
          fromModuleId: 'exception',
          toModuleId: 'base-policy',
          relationshipType: 'EXCEPTION_TO_V1',
        }),
      ],
    },
  }
}
function execute(source: GuestQuerySource, product = 'museum token') {
  const compiled = compileGuestQueryCanonicalSource(source)
  const result = compiled.prepared
    .evaluate({
      tenantId: source.tenantId,
      venueId: source.venueId,
      mode: 'list',
      predicates: [{ field: 'product', name: product }],
    })
    .page()
  return { compiled, result }
}
describe('published canonical query compilation', () => {
  it.each(['museum', 'botanical garden', 'theme park', 'food hall'])(
    'compiles positive offers and whole policies for %s',
    (family) => {
      const source = fixture(family)
      const { compiled, result } = execute(source, `${family} token`)
      expect(result.matchingKeys).toEqual(['place:seller'])
      expect(result.unknownCandidateCount).toBe(0)
      expect(compiled.policyCoverage).toBe('UNKNOWN')
      expect(compiled.canonicalAuthority).toBe(true)
      expect(compiled.snapshot.records).toHaveLength(1)
      expect(compiled.snapshot.records[0]!.products).toMatchObject({
        state: 'KNOWN',
        completeness: 'POSITIVE_ONLY',
      })
      expect(compiled.canonicalSources.map((row) => row.moduleId).sort()).toEqual(
        source.canonicalModules!.modules.map((row) => row.moduleId).sort(),
      )
      for (const row of compiled.canonicalSources) {
        const original = source.canonicalModules!.modules.find(
          (item) => item.moduleId === row.moduleId,
        )!
        expect(JSON.parse(row.text)).toEqual(original)
        expect(row.snapshot).toEqual(original)
        expect(compiled.relatedKeysByPlace['place:seller']).toContain(row.key)
        expect(compiled.snapshot.evidenceKeys).toContain(row.key)
      }
      const absent = execute(source, 'absent product').result
      expect(absent.knownMatchCount).toBe(0)
      expect(absent.unknownCandidateCount).toBe(1)
      expect(absent.exactEligibleCount).toBeNull()
    },
  )
  it('absence of canonical sidecar never promotes prose or item location to sale', () => {
    const source = fixture()
    delete source.canonicalModules
    expect(execute(source).compiled.canonicalAuthority).toBe(false)
    expect(execute(source).result.unknownCandidateCount).toBe(1)
    source.canonicalModules = {
      contract: 'published-query-source-v1',
      modules: [
        module('located', {
          kind: 'ITEM',
          name: 'museum token',
          itemType: 'PRODUCT',
          placeId: 'seller',
        }),
      ],
    }
    expect(execute(source).result.knownMatchCount).toBe(0)
    expect(execute(source).compiled.canonicalSources).toEqual([])
  })
  it.each(['offer', 'product', 'seller-module'])(
    'withdrawal of %s invalidates positive proof',
    (id) => {
      const source = fixture()
      source.canonicalModules!.modules = source.canonicalModules!.modules.filter(
        (row) => row.moduleId !== id,
      )
      const { compiled, result } = execute(source)
      expect(result.knownMatchCount).toBe(0)
      expect(result.unknownCandidateCount).toBe(1)
      expect(compiled.snapshot.records[0]!.products).toEqual({ state: 'UNKNOWN' })
    },
  )
  it('never exposes hidden-place-bound modules, their offers, policies or exception bodies', () => {
    const source = fixture()
    const seller = source.canonicalModules!.modules[0]!
    if (seller.payload.kind !== 'SERVICE') throw new Error('fixture')
    seller.payload.placeId = 'hidden-place'
    const { compiled, result } = execute(source)
    expect(result.knownMatchCount).toBe(0)
    expect(compiled.canonicalSources).toEqual([])
    expect(compiled.prepared.planningVocabulary().features).toEqual([])
    expect(JSON.stringify(compiled.canonicalSources)).not.toContain('hidden-place')
  })
  it.each(['product', 'offer', 'seller-module'])(
    'guards effective endpoint boundaries for %s',
    (id) => {
      const source = fixture()
      const row = source.canonicalModules!.modules.find((value) => value.moduleId === id)!
      row.effectiveFrom = '2026-10-21T05:00:00.001Z'
      expect(execute(source).result.knownMatchCount).toBe(0)
      row.effectiveFrom = clock
      expect(execute(source).result.knownMatchCount).toBe(1)
      row.effectiveUntil = clock
      expect(() => execute(source)).toThrow(/interval/)
      row.effectiveFrom = '2026-10-20T05:00:00.000Z'
      expect(execute(source).result.knownMatchCount).toBe(0)
    },
  )
  it('unknown/wrong-kind edges and ambiguous normalized product names never grant truth', () => {
    for (const type of ['SELLS', 'offers_product_v1', 'OFFERS_PRODUCT_V2']) {
      const source = fixture()
      const edge = source.canonicalModules!.modules[2]!
      if (edge.payload.kind !== 'RELATIONSHIP') throw new Error('fixture')
      edge.payload.relationshipType = type
      expect(execute(source).result.knownMatchCount).toBe(0)
    }
    const source = fixture()
    source.canonicalModules!.modules.push(
      module('ambiguous', { kind: 'ITEM', name: 'MUSEUM  TOKEN', itemType: 'PRODUCT' }),
    )
    expect(execute(source).result.knownMatchCount).toBe(0)
    expect(execute(source).compiled.unresolvedReasons).toContainEqual({
      moduleId: 'offer',
      reason: 'AMBIGUOUS_PRODUCT_NAME',
    })
  })
  it('dangling policy targets do not leak their whole body into context', () => {
    const source = fixture()
    const policy = source.canonicalModules!.modules[3]!
    if (policy.payload.kind !== 'POLICY') throw new Error('fixture')
    policy.payload.appliesTo.push('unresolved-target')
    const { compiled, result } = execute(source)
    expect(result.knownMatchCount).toBe(1)
    expect(compiled.canonicalSources.some((row) => row.moduleId === 'base-policy')).toBe(false)
    expect(compiled.canonicalSources.some((row) => row.moduleId === 'exception')).toBe(false)
    expect(compiled.policyCoverage).toBe('UNKNOWN')
  })
  it('retains every whole policy and exception edge through a bounded cyclic closure', () => {
    const source = fixture()
    source.canonicalModules!.modules.push(
      module('cycle', {
        kind: 'RELATIONSHIP',
        fromModuleId: 'base-policy',
        toModuleId: 'exception',
        relationshipType: 'EXCEPTION_TO_V1',
      }),
    )
    const { compiled } = execute(source)
    expect(compiled.canonicalSources).toHaveLength(7)
    expect(new Set(compiled.relatedKeysByPlace['place:seller']).size).toBe(7)
    expect(compiled.unresolvedReasons.some((row) => row.reason.includes('CYCLE'))).toBe(true)
    expect(compiled.policyCoverage).toBe('UNKNOWN')
  })
  it('rejects malformed, duplicate, non-public or proposal-shaped sidecars and mismatched source scope', () => {
    for (const alter of [
      (source: GuestQuerySource) => {
        source.canonicalModules!.modules.push(source.canonicalModules!.modules[0]!)
      },
      (source: GuestQuerySource) => {
        source.canonicalModules!.modules[0]!.audience = 'CLIENT' as never
      },
      (source: GuestQuerySource) => {
        source.canonicalModules!.modules[0]!.kind = 'POLICY'
      },
      (source: GuestQuerySource) => {
        source.asOf = 'tomorrow'
      },
      (source: GuestQuerySource) => {
        source.directory.searchVersion = 'other-source'
      },
      (source: GuestQuerySource) => {
        source.canonicalModules = { contract: 'proposal-cache' } as never
      },
    ]) {
      const source = fixture()
      alter(source)
      expect(() => execute(source)).toThrow()
    }
    const { compiled } = execute(fixture())
    expect(() =>
      compiled.prepared.evaluate({
        tenantId: 'tenant-b',
        venueId: 'venue-a',
        mode: 'list',
        predicates: [],
      }),
    ).toThrow(/scope/)
  })
  it('owns input and outward source snapshots independently of its prepared facts', () => {
    const source = fixture()
    const { compiled } = execute(source)
    source.canonicalModules!.modules.length = 0
    ;(compiled.snapshot.records as unknown[]).length = 0
    compiled.canonicalSources[0]!.snapshot.evidence.length = 0
    expect(
      compiled.prepared
        .evaluate({
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          mode: 'list',
          predicates: [{ field: 'product', name: 'museum token' }],
        })
        .page().knownMatchCount,
    ).toBe(1)
  })
  it('does not resolve a policy target by a similar place or service name', () => {
    const source = fixture()
    const policy = source.canonicalModules!.modules[3]!
    if (policy.payload.kind !== 'POLICY') throw new Error('fixture')
    policy.payload.appliesTo = ['museum counter']
    const { compiled } = execute(source)
    expect(compiled.canonicalSources.some((row) => row.kind === 'POLICY')).toBe(false)
    expect(compiled.unresolvedReasons).toContainEqual({
      moduleId: 'base-policy',
      reason: 'POLICY_TARGET_UNRESOLVED',
    })
  })
  it('policy-only context includes its exact target proof without inventing a product', () => {
    const source = fixture()
    source.canonicalModules!.modules = source.canonicalModules!.modules.filter(
      (row) => row.moduleId !== 'offer',
    )
    const { compiled, result } = execute(source)
    expect(result.knownMatchCount).toBe(0)
    expect(compiled.canonicalSources.map((row) => row.moduleId).sort()).toEqual([
      'base-policy',
      'exception',
      'exception-edge',
      'seller-module',
    ])
    expect(compiled.snapshot.records).toHaveLength(1)
  })
  it('hidden product binding cannot grant sale even through a visible seller edge', () => {
    const source = fixture()
    const item = source.canonicalModules!.modules[1]!
    if (item.payload.kind !== 'ITEM') throw new Error('fixture')
    item.payload.placeId = 'hidden-place'
    const { compiled, result } = execute(source)
    expect(result.knownMatchCount).toBe(0)
    expect(
      compiled.canonicalSources.some(
        (row) => row.moduleId === 'product' || row.moduleId === 'offer',
      ),
    ).toBe(false)
  })
  it('unknown exception relationship never silently supplies governing authority', () => {
    const source = fixture()
    const edge = source.canonicalModules!.modules[5]!
    if (edge.payload.kind !== 'RELATIONSHIP') throw new Error('fixture')
    edge.payload.relationshipType = 'EXCEPTION_TO_V2'
    const { compiled } = execute(source)
    expect(compiled.canonicalSources.some((row) => row.moduleId === 'exception')).toBe(false)
    expect(compiled.unresolvedReasons).toContainEqual({
      moduleId: 'exception',
      reason: 'POLICY_SCOPE_UNDECLARED',
    })
    expect(compiled.policyCoverage).toBe('UNKNOWN')
  })
  it('current independent source snapshots preserve exact publication and evidence changes', () => {
    const source = fixture()
    const before = execute(source).compiled
    source.version = 'admitted-v2'
    source.directory.searchVersion = source.version
    const item = source.canonicalModules!.modules[1]!
    item.publicationId = 'new-publication'
    item.publicationOrder = '999999999999999999'
    item.evidence[0]!.excerptHash = 'b'.repeat(64)
    const after = execute(source).compiled
    expect(after.snapshot.version).toBe('admitted-v2')
    expect(after.canonicalSources.find((row) => row.moduleId === 'product')!.snapshot).toEqual(item)
    expect(
      before.canonicalSources.find((row) => row.moduleId === 'product')!.snapshot.publicationId,
    ).toBe('pub-product')
  })
  it('does not broaden a differently targeted exception onto the base policy place', () => {
    const source = fixture()
    source.directory.places.push({
      ...source.directory.places[0]!,
      id: 'other',
      name: 'Other shop',
    })
    source.canonicalModules!.modules.push(
      module('other-service', { kind: 'SERVICE', name: 'Other counter', placeId: 'other' }),
    )
    const exception = source.canonicalModules!.modules[4]!
    if (exception.payload.kind !== 'POLICY') throw new Error('fixture')
    exception.payload.appliesTo = ['other-service']
    const { compiled } = execute(source)
    expect(compiled.relatedKeysByPlace['place:seller']).toContain('canonical:rev-base-policy')
    expect(compiled.relatedKeysByPlace['place:seller']).not.toContain('canonical:rev-exception')
    expect(compiled.relatedKeysByPlace['place:seller']).not.toContain(
      'canonical:rev-exception-edge',
    )
    expect(compiled.relatedKeysByPlace['place:other'] ?? []).not.toContain(
      'canonical:rev-exception',
    )
    expect(compiled.canonicalSources.some((row) => row.moduleId === 'exception')).toBe(false)
    expect(compiled.unresolvedReasons).toContainEqual({
      moduleId: 'exception',
      reason: 'EXCEPTION_SCOPE_CONFLICT',
    })
    expect(compiled.policyCoverage).toBe('UNKNOWN')
  })
  it('uses only the scope intersection and retains both whole rules plus edge for an overlapping exception', () => {
    const source = fixture()
    source.directory.places.push({
      ...source.directory.places[0]!,
      id: 'other',
      name: 'Other shop',
    })
    source.canonicalModules!.modules.push(
      module('other-service', { kind: 'SERVICE', name: 'Other counter', placeId: 'other' }),
    )
    const base = source.canonicalModules!.modules[3]!
    const exception = source.canonicalModules!.modules[4]!
    if (base.payload.kind !== 'POLICY' || exception.payload.kind !== 'POLICY')
      throw new Error('fixture')
    base.payload.appliesTo.push('other-service')
    exception.payload.appliesTo = ['other-service']
    const { compiled } = execute(source)
    expect(compiled.relatedKeysByPlace['place:seller']).not.toContain('canonical:rev-exception')
    expect(compiled.relatedKeysByPlace['place:other']).toEqual(
      expect.arrayContaining([
        'canonical:rev-base-policy',
        'canonical:rev-exception',
        'canonical:rev-exception-edge',
      ]),
    )
    expect(
      compiled.unresolvedReasons.some((row) => row.reason === 'EXCEPTION_SCOPE_CONFLICT'),
    ).toBe(false)
  })
  it('merges repeated offer and service proofs for one product at one place', () => {
    const source = fixture()
    source.canonicalModules!.modules.push(
      module('second-service', { kind: 'SERVICE', name: 'Second counter', placeId: 'seller' }),
      module('second-offer', {
        kind: 'RELATIONSHIP',
        fromModuleId: 'second-service',
        toModuleId: 'product',
        relationshipType: 'OFFERS_PRODUCT_V1',
      }),
      module('duplicate-offer', {
        kind: 'RELATIONSHIP',
        fromModuleId: 'seller-module',
        toModuleId: 'product',
        relationshipType: 'OFFERS_PRODUCT_V1',
      }),
    )
    const { compiled, result } = execute(source)
    expect(result.knownMatchCount).toBe(1)
    const product = compiled.snapshot.records[0]!.products!
    if (product.state !== 'KNOWN') throw new Error('expected supported product')
    expect(product.offers).toHaveLength(1)
    expect(new Set(product.offers[0]!.sources.map((row) => row.sourceKey))).toEqual(
      new Set([
        'canonical:rev-product',
        'canonical:rev-seller-module',
        'canonical:rev-offer',
        'canonical:rev-second-service',
        'canonical:rev-second-offer',
        'canonical:rev-duplicate-offer',
      ]),
    )
    expect(compiled.relatedKeysByPlace['place:seller']).toEqual(
      expect.arrayContaining([
        'canonical:rev-second-service',
        'canonical:rev-second-offer',
        'canonical:rev-duplicate-offer',
      ]),
    )
  })
  it('does not intersect different service identities merely because their place is the same', () => {
    const source = fixture()
    source.canonicalModules!.modules.push(
      module('other-service', { kind: 'SERVICE', name: 'Other counter', placeId: 'seller' }),
    )
    const exception = source.canonicalModules!.modules[4]!
    if (exception.payload.kind !== 'POLICY') throw new Error('fixture')
    exception.payload.appliesTo = ['other-service']
    const { compiled } = execute(source)
    expect(compiled.relatedKeysByPlace['place:seller']).not.toContain('canonical:rev-exception')
    expect(compiled.canonicalSources.some((row) => row.moduleId === 'exception')).toBe(false)
    expect(compiled.unresolvedReasons).toContainEqual({
      moduleId: 'exception',
      reason: 'EXCEPTION_SCOPE_CONFLICT',
    })
  })
  it('keeps inherited target identity intersections narrow throughout chained exceptions', () => {
    const source = fixture()
    source.canonicalModules!.modules.push(
      module('other-service', { kind: 'SERVICE', name: 'Other counter', placeId: 'seller' }),
      module('later-exception', {
        kind: 'POLICY',
        title: 'Later exception',
        rule: 'Only selected riders pay $1.',
        appliesTo: ['seller-module'],
      }),
      module('later-edge', {
        kind: 'RELATIONSHIP',
        fromModuleId: 'later-exception',
        toModuleId: 'exception',
        relationshipType: 'EXCEPTION_TO_V1',
      }),
    )
    const base = source.canonicalModules!.modules[3]!
    const exception = source.canonicalModules!.modules[4]!
    if (base.payload.kind !== 'POLICY' || exception.payload.kind !== 'POLICY')
      throw new Error('fixture')
    base.payload.appliesTo.push('other-service')
    exception.payload.appliesTo = ['other-service']
    const { compiled } = execute(source)
    expect(compiled.canonicalSources.some((row) => row.moduleId === 'exception')).toBe(true)
    expect(compiled.canonicalSources.some((row) => row.moduleId === 'later-exception')).toBe(false)
    expect(compiled.unresolvedReasons).toContainEqual({
      moduleId: 'later-exception',
      reason: 'EXCEPTION_SCOPE_CONFLICT',
    })
  })
  it('a recognized dangling exception edge cannot promote its exception as standalone direct policy', () => {
    const source = fixture()
    source.canonicalModules!.modules = source.canonicalModules!.modules.filter(
      (row) => row.moduleId !== 'base-policy',
    )
    const exception = source.canonicalModules!.modules.find((row) => row.moduleId === 'exception')!
    if (exception.payload.kind !== 'POLICY') throw new Error('fixture')
    exception.payload.appliesTo = ['seller-module']
    const { compiled } = execute(source)
    expect(compiled.canonicalSources.some((row) => row.moduleId === 'exception')).toBe(false)
    expect(compiled.unresolvedReasons).toContainEqual({
      moduleId: 'exception',
      reason: 'EXCEPTION_SCOPE_UNRESOLVED',
    })
  })
  it('fails the entire compilation when a dense governing ancestry exceeds its work bound', () => {
    const source = fixture()
    const rows = [source.canonicalModules!.modules[0]!]
    for (let index = 0; index < 2100; index++) {
      rows.push(
        module(`policy-${index}`, {
          kind: 'POLICY',
          title: `Rule ${index}`,
          rule: 'Whole condition.',
          appliesTo: ['seller-module'],
        }),
      )
      if (index)
        rows.push(
          module(`edge-${index}`, {
            kind: 'RELATIONSHIP',
            fromModuleId: `policy-${index}`,
            toModuleId: `policy-${index - 1}`,
            relationshipType: 'EXCEPTION_TO_V1',
          }),
        )
    }
    source.canonicalModules!.modules = rows
    expect(() => compileGuestQueryCanonicalSource(source)).toThrow(/graph work exceeds/)
  })
})
