import { describe, expect, it, vi } from 'vitest'
import type { EffectivePublishedUniversalContentSnapshot } from '@pathfinder/db'
import type { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'
import { compileGuestQueryCanonicalSource } from './guest-query-canonical-projection'
import { formatGuestQueryDirectAnswer } from './guest-query-direct-answer'
import { loadGuestVenueDirectory } from './guest-venue-directory'
import type { GuestQuerySource } from './guest-query-source'
import type { GuestStructuredQuery } from './guest-structured-query'
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

type Module = EffectivePublishedUniversalContentSnapshot
function append(value: GuestQuerySource, id: string, payload: GeneralizedContentPayload): Module {
  const row: Module = {
    moduleId: id,
    revisionId: `rev-${id}`,
    publicationId: `pub-${id}`,
    publicationOrder: String(value.canonicalModules!.modules.length + 1),
    kind: payload.kind,
    version: 1,
    payload,
    audience: 'PUBLIC',
    effectiveFrom: null,
    effectiveUntil: null,
    evidence: [],
  }
  value.canonicalModules!.modules.push(row)
  return row
}
function alias(row: Module): GuestQuerySource['directory']['knowledge'][number] {
  const payload = row.payload
  if (payload.kind !== 'SERVICE' && payload.kind !== 'ITEM' && payload.kind !== 'POLICY')
    throw new Error('Use an explicit body for unsupported alias kinds')
  return {
    id: `alias-${row.moduleId}`,
    title: payload.kind === 'POLICY' ? payload.title : payload.name,
    category: payload.kind,
    content:
      payload.kind === 'POLICY'
        ? payload.rule
        : payload.kind === 'SERVICE'
          ? [payload.description, payload.availability].filter((part) => part != null).join('\n')
          : [payload.description, `Item type: ${payload.itemType}`]
              .filter((part) => part != null)
              .join('\n'),
    sourceType: 'UNIVERSAL_CONTENT',
    sourceName: null,
    sourceUrl: null,
    contentModuleId: row.moduleId,
    contentRevisionId: row.revisionId,
    contentPublicationId: row.publicationId,
  }
}
function remotePolicies(count = 1, length = 10) {
  const value = products()
  append(value, 'remote-service', {
    kind: 'SERVICE',
    name: 'Remote counter',
    placeId: 'shop-003',
    description: 'Only at remote counter.',
    availability: 'Evenings only.',
  })
  for (let i = 0; i < count; i++) {
    const row = append(value, `remote-${i}`, {
      kind: 'POLICY',
      title: `Remote rule ${i}`,
      rule: `Unique restriction ${i}: ${'x'.repeat(length)}`,
      appliesTo: ['remote-service'],
    })
    value.directory.knowledge.push(alias(row))
  }
  return value
}
function ready(value: GuestQuerySource, q = productQuery) {
  const output = render(value, q)
  if (output.status !== 'READY') throw new Error(output.reason)
  return output
}

describe('exact materialized Knowledge scope', () => {
  it.each([
    [110, 1],
    [200, 100],
  ])('omits %i fully scoped remote aliases (%i body chars)', (count, length) => {
    const value = remotePolicies(count, length)
    const output = ready(value)
    expect(output.result.knownMatchCount).toBe(3)
    expect(output.knowledge).toEqual([])
    expect(output.answer).not.toContain('Unique restriction')
    expect(output.canonicalSources.some((body) => body.moduleId.startsWith('remote'))).toBe(false)
    expect(
      compileGuestQueryCanonicalSource(value).knowledgeScopes.filter(
        (scope) => scope.snapshot.kind === 'POLICY' && scope.snapshot.moduleId.startsWith('remote'),
      ),
    ).toHaveLength(count)
  })

  it('deduplicates selected exact aliases only after rendering complete bodies including item type', () => {
    const value = products()
    value.directory.knowledge = value
      .canonicalModules!.modules.filter((row) => ['SERVICE', 'ITEM', 'POLICY'].includes(row.kind))
      .map(alias)
    const output = ready(value)
    expect(output.knowledge).toEqual([])
    expect(output.answer).toContain('Item type: PRODUCT')
    expect(output.answer).toContain('Equipment is sold separately.')
    expect(output.answer).toContain('closed during storms.')
    expect(output.answer).toContain('Adult accompaniment still applies.')
    expect(output.canonicalSources.map((row) => row.moduleId)).toContain('exception-edge-private')
  })

  it.each([
    'contentModuleId',
    'contentRevisionId',
    'contentPublicationId',
    'title',
    'category',
    'content',
    'sourceType',
  ] as const)('retains aliases with mismatched %s', (field) => {
    const value = remotePolicies()
    value.directory.knowledge[0]![field] = `different-${field}`
    expect(ready(value).knowledge).toEqual(value.directory.knowledge)
  })

  it.each(['contentModuleId', 'contentRevisionId', 'contentPublicationId'] as const)(
    'retains aliases without %s',
    (field) => {
      const value = remotePolicies()
      delete value.directory.knowledge[0]![field]
      expect(ready(value).knowledge).toEqual(value.directory.knowledge)
    },
  )

  it('retains true legacy rows and still declines a large unscoped corpus', () => {
    const value = remotePolicies(110, 1)
    for (const topic of value.directory.knowledge) {
      topic.sourceType = 'MANUAL'
      delete topic.contentModuleId
      delete topic.contentRevisionId
      delete topic.contentPublicationId
    }
    expect(render(value, productQuery)).toMatchObject({
      status: 'UNSUPPORTED',
      reason: 'ANSWER_BOUND',
    })
  })

  it.each([
    'missing-publication',
    'republished',
    'expired',
    'future',
    'unauthorized-place',
    'missing-target',
    'empty-scope',
    'unsupported-edge',
    'missing-endpoint',
    'repeated-ancestor',
    'cycle',
    'ambiguous-product',
  ])('retains conservative evidence for %s', (scenario) => {
    const value = remotePolicies()
    const rows = value.canonicalModules!.modules
    const policy = rows.find((row) => row.moduleId === 'remote-0')!
    const service = rows.find((row) => row.moduleId === 'remote-service')!
    if (policy.payload.kind !== 'POLICY' || service.payload.kind !== 'SERVICE')
      throw new Error('fixture')
    if (scenario === 'missing-publication') rows.splice(rows.indexOf(policy), 1)
    if (scenario === 'republished') policy.publicationId = 'pub-new-head'
    if (scenario === 'expired') policy.effectiveUntil = value.asOf
    if (scenario === 'future') policy.effectiveFrom = '2027-01-01T00:00:00.000Z'
    if (scenario === 'unauthorized-place') service.payload.placeId = 'hidden-place'
    if (scenario === 'missing-target') policy.payload.appliesTo.push('missing-module')
    if (scenario === 'empty-scope') policy.payload.appliesTo = []
    if (scenario === 'unsupported-edge' || scenario === 'missing-endpoint')
      append(value, 'bad-edge', {
        kind: 'RELATIONSHIP',
        fromModuleId: 'remote-service',
        toModuleId: scenario === 'missing-endpoint' ? 'missing' : 'product-private-id',
        relationshipType: 'NOT_A_SCOPE',
      })
    if (scenario === 'cycle' || scenario === 'repeated-ancestor') {
      append(value, 'ancestor', {
        kind: 'POLICY',
        title: 'Ancestor',
        rule: 'Always retained.',
        appliesTo: ['remote-service'],
      })
      append(value, 'ancestor-edge', {
        kind: 'RELATIONSHIP',
        fromModuleId: 'remote-0',
        toModuleId: 'ancestor',
        relationshipType: 'EXCEPTION_TO_V1',
      })
      append(value, 'repeat-edge', {
        kind: 'RELATIONSHIP',
        fromModuleId: scenario === 'cycle' ? 'ancestor' : 'remote-0',
        toModuleId: scenario === 'cycle' ? 'remote-0' : 'ancestor',
        relationshipType: 'EXCEPTION_TO_V1',
      })
    }
    if (scenario === 'ambiguous-product') {
      append(value, 'duplicate-item', { kind: 'ITEM', name: 'Sketch kit', itemType: 'PRODUCT' })
      policy.payload.appliesTo = ['product-private-id']
    }
    expect(ready(value).knowledge).toEqual(value.directory.knowledge)
  })

  it('retains a selected service whose canonical body was not attached', () => {
    const value = remotePolicies(0)
    const row = value.canonicalModules!.modules.find((row) => row.moduleId === 'remote-service')!
    value.directory.knowledge = [alias(row)]
    expect(ready(value, query()).knowledge).toEqual(value.directory.knowledge)
  })

  it('retains selected topic-domain rows exactly once', () => {
    const value = remotePolicies()
    const output = ready(value, {
      ...query(),
      predicates: [{ field: 'kind', equals: 'KNOWLEDGE' }],
    })
    expect(output.knowledge).toEqual(value.directory.knowledge)
    expect(output.answer.split(value.directory.knowledge[0]!.content)).toHaveLength(2)
  })

  it('omits a complete remote EXHIBIT but retains unscoped EVENT and OPERATIONAL_FACT aliases', () => {
    const value = remotePolicies(0)
    const row = append(value, 'display-item', {
      kind: 'ITEM',
      name: 'Display',
      itemType: 'EXHIBIT',
      placeId: 'shop-003',
      description: 'Fragile display.',
    })
    const event = append(value, 'event', {
      kind: 'EVENT',
      name: 'Tomorrow',
      description: 'Tomorrow only.',
      startsAt: '2026-10-22T12:00:00.000Z',
      endsAt: null,
      placeId: 'shop-003',
    })
    const fact = append(value, 'fact', {
      kind: 'OPERATIONAL_FACT',
      label: 'Status',
      value: 'Call staff.',
      expiresAt: null,
    })
    value.directory.knowledge = [
      alias(row),
      ...[event, fact].map((module) => ({
        ...alias(row),
        id: `alias-${module.moduleId}`,
        title: module.kind === 'EVENT' ? 'Tomorrow' : 'Status',
        category: module.kind,
        content:
          module.kind === 'EVENT'
            ? 'Tomorrow only.\nStarts: 2026-10-22 12:00:00+00\nEnds: not specified'
            : 'Call staff.',
        contentModuleId: module.moduleId,
        contentRevisionId: module.revisionId,
        contentPublicationId: module.publicationId,
      })),
    ]
    const output = ready(value)
    expect(output.knowledge).toEqual(value.directory.knowledge.slice(1))
    expect(output.answer).not.toContain('Fragile display.')
    expect(output.answer).toContain('Tomorrow only.')
    expect(output.answer).toContain('Call staff.')
  })

  it('does not suppress a stale alias when current publication has the same revision', () => {
    const value = remotePolicies()
    const compiled = compileGuestQueryCanonicalSource(value)
    value.canonicalModules!.modules.find((row) => row.moduleId === 'remote-0')!.publicationId =
      'new-publication'
    const output = formatGuestQueryDirectAnswer({ source: value, compiled, query: productQuery })
    expect(output.status).toBe('READY')
    if (output.status === 'READY') expect(output.knowledge).toEqual(value.directory.knowledge)
  })

  it('preserves exact current binding IDs through the directory loader and excludes stale/activated rows', async () => {
    const value = remotePolicies()
    const topic = value.directory.knowledge[0]!
    const current = {
      ...topic,
      updatedAt: new Date(value.asOf),
      lastReviewedAt: null,
      contentRevision: {
        createdBy: 'operator',
        effectiveFrom: null,
        effectiveUntil: null,
        operationalFact: null,
      },
      contentPublication: {
        eventOrder: 2n,
        module: { publications: [{ id: topic.contentPublicationId, eventOrder: 2n }] },
      },
    }
    const stale = { ...current, id: 'stale', contentPublicationId: 'old-pub' }
    const activated = { ...current, id: 'activated' }
    const result = await loadGuestVenueDirectory({
      tenantId: value.tenantId,
      venueId: value.venueId,
      includeSecondLayer: false,
      asOf: new Date(value.asOf),
      reader: {
        venueKnowledgeEntry: { findMany: vi.fn().mockResolvedValue([current, stale, activated]) },
        place: { findMany: vi.fn().mockResolvedValue([]) },
        legacyKnowledgeAdoptionActivation: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ adoption: { legacyKnowledgeEntryId: 'activated' } }]),
        },
      },
    })
    expect(result.knowledge).toEqual([{ ...topic, updatedAt: current.updatedAt }])
  })
})
function unoffered(count = 2, length = 20) {
  const value = source()
  value.canonicalModules = { contract: 'published-query-source-v1', modules: [] }
  for (let i = 0; i < count; i++) {
    const row = append(value, `unoffered-${i}`, {
      kind: 'ITEM',
      itemType: 'PRODUCT',
      name: `Unlinked product ${i}`,
      description: `Whole metadata ${i}: ${'x'.repeat(length)}`,
    })
    value.directory.knowledge.push(alias(row))
  }
  return value
}
describe('identity scoped product metadata, distinct from sale and policy scope', () => {
  it('rejects reflective construction of metadata authority from caller-authored rows', () => {
    const value = unoffered(1)
    const compiled = compileGuestQueryCanonicalSource(value)
    expect(() =>
      Reflect.construct(compiled.productMetadataProof.constructor, [
        compiled.prepared,
        value.canonicalModules!.modules,
      ]),
    ).toThrow('compiler authority')
    expect(() =>
      Reflect.construct(compiled.productMetadataProof.constructor, [
        compiled.prepared,
        value.canonicalModules!.modules,
        Symbol('product-metadata-compiler-issuer'),
      ]),
    ).toThrow('compiler authority')
  })
  it('retains requested tainted canonical metadata even when other predicates exclude its sellers', () => {
    const value = products()
    append(value, 'bad-edge-independent', {
      kind: 'RELATIONSHIP',
      relationshipType: 'OFFERS_PRODUCT_V1',
      fromModuleId: 'missing-seller',
      toModuleId: 'product-private-id',
    })
    const output = ready(value, {
      ...query(),
      domain: 'PLACE',
      predicates: [
        { field: 'product', name: 'Sketch kit' },
        { field: 'name', equals: 'Shop 3' },
      ],
    })
    expect(output.answer).toContain('Each kit costs $8. Equipment is sold separately.')
    expect(output.canonicalSources.some((row) => row.moduleId === 'product-private-id')).toBe(true)
    expect(output.places).toEqual([])
  })
  it('omits 2000 unrelated whole product aliases with source/query-bound auditable proof, not complete scope', () => {
    const value = unoffered(2000, 200)
    const compiled = compileGuestQueryCanonicalSource(value)
    expect(
      compiled.knowledgeScopes.every(
        (row) => row.disposition === 'IDENTITY_SCOPED_PRODUCT_METADATA',
      ),
    ).toBe(true)
    expect(compiled.relatedKeysByPlace).toEqual({})
    const output = ready(value, { ...query(), domain: 'PLACE' })
    expect(output.omittedProductMetadata).toHaveLength(2000)
    expect(output.receipt.productMetadataOmission).toMatchObject({
      count: 2000,
      proofSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(output.answer).not.toContain('Whole metadata')
    expect(output.result.knownMatchCount).toBe(1)
    expect(output.policyCoverage).toBe('UNKNOWN')
    expect(output.answer).toContain(value.directory.places[0]!.longDescription!)
    const changed = ready(value, {
      ...query(),
      domain: 'PLACE',
      predicates: [{ field: 'name', equals: 'Shop 0' }],
    })
    expect(changed.receipt.productMetadataOmission.proofSha256).not.toBe(
      output.receipt.productMetadataOmission.proofSha256,
    )
  })
  it('retains every directly requested product whole with zero known sellers and no invented location, including AND', () => {
    const value = unoffered()
    const output = ready(value, {
      ...query(),
      domain: 'PLACE',
      predicates: [
        { field: 'product', name: 'Unlinked product 0' },
        { field: 'product', name: 'Unlinked product 1' },
      ],
    })
    expect(output.result.knownMatchCount).toBe(0)
    expect(output.result.exactEligibleCount).toBeNull()
    expect(output.canonicalSources).toHaveLength(2)
    expect(output.answer).toContain('Whole metadata 0:')
    expect(output.answer).toContain('Whole metadata 1:')
    expect(output.places).toEqual([])
    expect(output.answer).not.toContain('Offering link')
  })
  it('always retains selected Knowledge even when it is an exact product projection', () => {
    const value = unoffered()
    const output = ready(value, {
      ...query(),
      domain: 'KNOWLEDGE',
      predicates: [{ field: 'name', equals: 'Unlinked product 0' }],
    })
    expect(output.knowledge.map((row) => row.id)).toEqual(['alias-unoffered-0'])
    expect(output.answer).toContain(
      value.directory.knowledge[0]!.content.split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
    )
    expect(output.omittedProductMetadata.map((row) => row.moduleId)).toEqual(['unoffered-1'])
  })
  it.each([[['unoffered-0']], [['visitors']], [[]]])(
    'keeps unresolved policy target %j conservative and whole',
    (appliesTo) => {
      const value = unoffered()
      const policy = append(value, 'policy', {
        kind: 'POLICY',
        title: 'Whole rule',
        rule: 'All stated conditions remain together; no waiver.',
        appliesTo: appliesTo as string[],
      })
      value.directory.knowledge.push(alias(policy))
      const output = ready(value, { ...query(), domain: 'PLACE' })
      expect(output.answer).toContain('All stated conditions remain together; no waiver.')
      expect(output.knowledge.map((row) => row.id)).toContain('alias-policy')
    },
  )
  it.each(['missing', 'hidden', 'wrong-kind'])(
    'taints incident products for %s endpoint and never promotes an offer',
    (type) => {
      const value = unoffered()
      if (type !== 'missing')
        append(value, 'bad-seller', {
          kind: 'SERVICE',
          name: 'Bad seller',
          placeId: type === 'hidden' ? 'hidden-place' : 'shop-000',
        })
      append(value, 'bad-edge', {
        kind: 'RELATIONSHIP',
        relationshipType: type === 'wrong-kind' ? 'UNKNOWN_RELATIONSHIP' : 'OFFERS_PRODUCT_V1',
        fromModuleId: 'bad-seller',
        toModuleId: 'unoffered-0',
      })
      const compiled = compileGuestQueryCanonicalSource(value)
      expect(compiled.knowledgeScopes.some((row) => row.snapshot.moduleId === 'unoffered-0')).toBe(
        false,
      )
      const output = ready(value, { ...query(), domain: 'PLACE' })
      expect(output.knowledge.map((row) => row.id)).toContain('alias-unoffered-0')
      expect(output.result.rows[0]!.products).not.toMatchObject({ state: 'KNOWN' })
    },
  )
  it('does not treat ITEM.placeId as an offer', () => {
    const value = unoffered(1)
    const item = value.canonicalModules!.modules[0]!
    if (item.payload.kind === 'ITEM') item.payload.placeId = 'shop-000'
    const output = ready(value, {
      ...query(),
      domain: 'PLACE',
      predicates: [{ field: 'product', name: 'Unlinked product 0' }],
    })
    expect(output.result.knownMatchCount).toBe(0)
    expect(output.result.exactEligibleCount).toBeNull()
  })
  it('retains duplicate names, expired or missing current product identities conservatively', () => {
    for (const type of ['duplicate', 'expired', 'missing']) {
      const value = unoffered()
      const item = value.canonicalModules!.modules[0]!
      if (type === 'duplicate')
        append(value, 'duplicate', {
          kind: 'ITEM',
          itemType: 'PRODUCT',
          name: 'Unlinked product 0',
          description: 'Other identity',
        })
      if (type === 'expired') item.effectiveUntil = '2026-10-20T00:00:00.000Z'
      if (type === 'missing') value.canonicalModules!.modules.shift()
      const output = ready(value, { ...query(), domain: 'PLACE' })
      expect(output.knowledge.map((row) => row.id)).toContain('alias-unoffered-0')
    }
  })
  it.each(['content', 'title', 'contentRevisionId', 'contentPublicationId', 'sourceType'])(
    'does not omit mismatched projection %s',
    (field) => {
      const value = unoffered()
      ;(value.directory.knowledge[0] as unknown as Record<string, unknown>)[field] = 'changed'
      const output = ready(value, { ...query(), domain: 'PLACE' })
      expect(output.knowledge.map((row) => row.id)).toContain('alias-unoffered-0')
    },
  )
  it('fails before output for missing requested canonical body and whole requested body bounds', () => {
    const value = products()
    const compiled = compileGuestQueryCanonicalSource(value)
    compiled.canonicalSources.find((row) => row.kind === 'ITEM')!.text = 'missing whole body'
    expect(
      formatGuestQueryDirectAnswer({
        source: value,
        compiled,
        query: {
          ...query(),
          domain: 'PLACE',
          predicates: [{ field: 'product', name: 'Sketch kit' }],
        },
      }),
    ).toMatchObject({ status: 'UNSUPPORTED', reason: 'SOURCE_MISMATCH' })
    expect(
      render(unoffered(1, 9950), {
        ...query(),
        domain: 'PLACE',
        predicates: [{ field: 'product', name: 'Unlinked product 0' }],
      }),
    ).toMatchObject({ status: 'UNSUPPORTED', reason: 'ANSWER_BOUND' })
  })
  it('does not interpret metadata prose as a global rule and cannot forge an identity proof', () => {
    const value = unoffered(1)
    const item = value.canonicalModules!.modules[0]!
    if (item.payload.kind === 'ITEM') item.payload.description = 'All visitors must wear purple.'
    value.directory.knowledge = [alias(item)]
    const compiled = compileGuestQueryCanonicalSource(value)
    const output = formatGuestQueryDirectAnswer({
      source: value,
      compiled,
      query: { ...query(), domain: 'PLACE' },
    })
    expect(output.status).toBe('READY')
    if (output.status === 'READY') expect(output.answer).not.toContain('wear purple')
    // Governed own-item semantics is explicit; prose was not parsed/classified as safe.
    compiled.productMetadataProof = {} as typeof compiled.productMetadataProof
    const rejected = formatGuestQueryDirectAnswer({
      source: value,
      compiled,
      query: { ...query(), domain: 'PLACE' },
    })
    expect(rejected.status).toBe('READY')
    if (rejected.status === 'READY') expect(rejected.answer).toContain('wear purple')
  })
  it('rebinds new offers to a new source while old metadata-only snapshot stays unknown', () => {
    const old = unoffered(1)
    const oldCompiled = compileGuestQueryCanonicalSource(old)
    const next = structuredClone(old)
    next.version = 'v2'
    next.directory.searchVersion = 'v2'
    append(next, 'seller', {
      kind: 'SERVICE',
      name: 'New seller',
      placeId: 'shop-000',
      description: 'Whole seller condition: adult required.',
    })
    append(next, 'offer', {
      kind: 'RELATIONSHIP',
      relationshipType: 'OFFERS_PRODUCT_V1',
      fromModuleId: 'seller',
      toModuleId: 'unoffered-0',
    })
    const q = {
      ...query(),
      domain: 'PLACE' as const,
      predicates: [{ field: 'product' as const, name: 'Unlinked product 0' }],
    }
    expect(oldCompiled.prepared.evaluate(q).page().knownMatchCount).toBe(0)
    const updated = ready(next, q)
    expect(updated.result.knownMatchCount).toBe(1)
    expect(updated.answer).toContain('Whole seller condition: adult required.')
    expect(updated.answer).toContain('Whole metadata 0:')
    expect(
      formatGuestQueryDirectAnswer({ source: next, compiled: oldCompiled, query: q }),
    ).toMatchObject({ status: 'UNSUPPORTED', reason: 'SOURCE_MISMATCH' })
    const forged = compileGuestQueryCanonicalSource(old)
    forged.productMetadataProof = compileGuestQueryCanonicalSource(next).productMetadataProof
    const conservative = formatGuestQueryDirectAnswer({
      source: old,
      compiled: forged,
      query: { ...query(), domain: 'PLACE' },
    })
    expect(conservative.status).toBe('READY')
    if (conservative.status === 'READY')
      expect(conservative.knowledge.map((row) => row.id)).toContain('alias-unoffered-0')
  })

  it('retains requested tainted metadata whole or declines if its only whole current body is missing', () => {
    const value = unoffered(1)
    append(value, 'bad-edge', {
      kind: 'RELATIONSHIP',
      relationshipType: 'OFFERS_PRODUCT_V1',
      fromModuleId: 'missing',
      toModuleId: 'unoffered-0',
    })
    const q = {
      ...query(),
      domain: 'PLACE' as const,
      predicates: [{ field: 'product' as const, name: 'Unlinked product 0' }],
    }
    const output = ready(value, q)
    expect(output.knowledge.map((row) => row.id)).toContain('alias-unoffered-0')
    expect(output.answer).toContain('Whole metadata 0:')
    expect(output.result.knownMatchCount).toBe(0)
    expect(output.result.exactEligibleCount).toBeNull()
    value.directory.knowledge = []
    expect(render(value, q)).toMatchObject({ status: 'UNSUPPORTED', reason: 'UNRESOLVED_SCOPE' })
  })
})
