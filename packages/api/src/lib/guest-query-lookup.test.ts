import { formatGuestQueryDirectAnswer } from './guest-query-direct-answer'
import { describe, it, expect } from 'vitest'
import type { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'
import type { GuestQuerySource } from './guest-query-source'
import {
  compileGuestQueryCanonicalSource,
  guestCanonicalEvidenceAuthority,
} from './guest-query-canonical-projection'
import {
  guestCanonicalAliasBody,
  prepareGuestKnowledgeAdmission,
} from './guest-query-whole-sources'
import { parseGuestQueryPlan, guestQueryPlanningPrompt } from './guest-query-planning'
import {
  prepareGuestChatQueryExperiment,
  guestQueryChatExperimentEnabled,
} from './guest-query-chat-experiment'

function source(size = 2): GuestQuerySource {
  const s: GuestQuerySource = {
    tenantId: 'fiction-tenant',
    venueId: 'fiction-venue',
    version: 'v1',
    asOf: '2026-10-21T05:00:00.000Z',
    coverage: 'COMPLETE',
    includeSecondLayer: false,
    readPath: 'LEGACY',
    directory: {
      incomplete: false,
      searchVersion: 'v1',
      places: Array.from({ length: size }, (_, i) => ({
        id: `p${i}`,
        name: `Fiction Counter ${i}`,
        type: 'SHOP',
        itemType: null,
        shortDescription: null,
        longDescription: `Counter ${i}; ask staff for eligibility.`,
        lat: null,
        lng: null,
        tags: [],
        areaName: 'Hall',
        hours: null,
        photoUrl: null,
        sourceType: 'MANUAL',
        sourceName: null,
        sourceUrl: null,
      })),
      knowledge: [],
    },
    canonicalModules: { contract: 'published-query-source-v1', modules: [] },
  }
  return s
}
function append(
  s: GuestQuerySource,
  id: string,
  payload: GeneralizedContentPayload,
  alias = false,
) {
  const m = {
    moduleId: id,
    revisionId: `r-${id}`,
    publicationId: `pub-${id}`,
    publicationOrder: String(s.canonicalModules!.modules.length + 1),
    kind: payload.kind,
    version: 1,
    payload,
    audience: 'PUBLIC' as const,
    effectiveFrom: null,
    effectiveUntil: null,
    evidence: [],
  }
  s.canonicalModules!.modules.push(m)
  const b = guestCanonicalAliasBody(m)
  if (alias && b)
    s.directory.knowledge.push({
      id: `a-${id}`,
      title: b.title,
      category: m.kind,
      content: b.content,
      sourceType: 'UNIVERSAL_CONTENT',
      sourceName: null,
      sourceUrl: null,
      contentModuleId: id,
      contentRevisionId: m.revisionId,
      contentPublicationId: m.publicationId,
    })
  return m
}
function graph() {
  const s = source()
  append(
    s,
    'item',
    {
      kind: 'ITEM',
      name: 'Comet kit',
      itemType: 'PRODUCT',
      description: 'Price $13; current stock is not guaranteed.',
    },
    true,
  )
  append(
    s,
    'service',
    {
      kind: 'SERVICE',
      name: 'Kit counter',
      placeId: 'p0',
      description: 'A paying adult is required.',
      availability: 'Weekends only; closes during storms.',
    },
    true,
  )
  append(s, 'offer', {
    kind: 'RELATIONSHIP',
    fromModuleId: 'service',
    toModuleId: 'item',
    relationshipType: 'OFFERS_PRODUCT_V1',
  })
  append(
    s,
    'policy',
    {
      kind: 'POLICY',
      title: 'Purchase rule',
      rule: 'Ages eight and up. No refunds; adult rule remains.',
      appliesTo: ['service'],
    },
    true,
  )
  s.directory.knowledge.push({
    id: 'manual',
    title: 'General warning',
    category: 'VISIT',
    content: 'Special closures may apply; ask staff.',
    sourceType: 'MANUAL',
    sourceName: null,
    sourceUrl: null,
  })
  return s
}
const question = 'Which Comet kit sellers allow a seven-year-old today?'
const plan = (unresolved = ['allow a seven-year-old today']) =>
  JSON.stringify({
    status: 'EVIDENCE_LOOKUP',
    anchor: { domain: 'PLACE', predicates: [{ field: 'product', name: 'Comet kit' }] },
    unresolved,
  })
const run = (s = graph(), text = plan(), q = question, directAnswer = true) =>
  prepareGuestChatQueryExperiment({
    source: s,
    question: q,
    directAnswer,
    interpret: async () => text,
  })

describe('bounded subject evidence lookup', () => {
  it('uses a model answer even with direct enabled; retains whole rules without qualified counts', async () => {
    const r = await run()
    expect(r.status).toBe('READY')
    if (r.status !== 'READY') return
    expect(r.partial).toBe(true)
    expect(r.summary).toMatchObject({
      version: 'guest-query-lookup-chat-v1',
      eligibilityEvaluated: false,
      qualifiedCountAvailable: false,
      anchorUnknownCandidateCount: 1,
    })
    expect(r.places.map((x) => x.id)).toEqual(['p0'])
    for (const text of [
      'Ages eight and up. No refunds; adult rule remains.',
      'Weekends only; closes during storms.',
      'Special closures may apply; ask staff.',
      'Price $13; current stock is not guaranteed.',
    ])
      expect(r.prompt).toContain(text)
    expect(r.prompt).not.toContain('exactEligibleCount')
    expect(r.prompt).not.toContain('knownMatchCount')
    expect(r.summary).not.toHaveProperty('exactEligibleCount')
    expect(r.canonicalSources.map((x) => x.moduleId)).toContain('offer')
  })
  it('keeps explicit whole product identity metadata with zero known sellers; never qualified zero', async () => {
    const s = source()
    append(
      s,
      'item',
      {
        kind: 'ITEM',
        name: 'Comet kit',
        itemType: 'PRODUCT',
        description: 'Ask staff for sellers and adult conditions.',
      },
      true,
    )
    const r = await run(s)
    expect(r.status).toBe('READY')
    if (r.status !== 'READY') return
    expect(r.places).toEqual([])
    expect(r.prompt).toContain('Ask staff for sellers and adult conditions.')
    expect(r.prompt).not.toContain('exactEligibleCount')
    expect(r.summary).toMatchObject({ eligibilityEvaluated: false, anchorUnknownCandidateCount: 2 })
  })
  it('falls back without positive subject evidence rather than turning unknown into absence', async () => {
    expect((await run(source())).status).toBe('BASELINE')
  })
  it('does not let legacy product prose establish seller authority', async () => {
    const s = source()
    delete s.canonicalModules
    s.directory.places[0]!.longDescription = 'Comet kit is sold here.'
    expect((await run(s)).status).toBe('BASELINE')
  })
  it.each(['', 'invented price', 'allow a seven-year-old TODAY'])(
    'rejects unresolved text not exact question substring: %s',
    async (span) => {
      expect((await run(graph(), plan([span]))).status).toBe('BASELINE')
    },
  )
  it('rejects duplicate spans', async () => {
    expect((await run(graph(), plan(['today', 'today']))).status).toBe('BASELINE')
  })
  it.each([
    { mode: 'count', domain: 'PLACE', predicates: [{ field: 'kind', equals: 'SHOP' }] },
    { domain: 'PLACE', predicates: [{ field: 'feature', name: 'adult', value: true }] },
    { domain: 'PLACE', predicates: [] },
    { domain: 'PLACE', predicates: [{ field: 'key', equals: 'place:p0' }] },
    { domain: 'KNOWLEDGE', predicates: [{ field: 'product', name: 'Comet kit' }] },
  ])('rejects expanded/unsupported anchor %j', async (anchor) => {
    expect(
      (
        await run(
          graph(),
          JSON.stringify({ status: 'EVIDENCE_LOOKUP', anchor, unresolved: ['today'] }),
        )
      ).status,
    ).toBe('BASELINE')
  })
  it('requires question-bound private catalog and rejects ambiguous name', () => {
    const s = source()
    s.directory.places[1]!.name = s.directory.places[0]!.name
    const p = compileGuestQueryCanonicalSource(s).prepared
    const q = 'Fiction Counter 0 under age eight'
    const text = JSON.stringify({
      status: 'EVIDENCE_LOOKUP',
      anchor: { domain: 'PLACE', predicates: [{ field: 'name', equals: 'Fiction Counter 0' }] },
      unresolved: ['under age eight'],
    })
    expect(() => parseGuestQueryPlan(text, p)).toThrow()
    expect(() =>
      parseGuestQueryPlan(text, p, { question: q, catalog: p.discoverNamedCandidates(q) }),
    ).toThrow()
  })
  it('keeps OR and negated selection explicitly unsupported in planner instructions', () => {
    const p = compileGuestQueryCanonicalSource(source()).prepared
    expect(guestQueryPlanningPrompt(p)).toContain(
      'Keep OR, negated selection, missing or ambiguous subject anchors UNSUPPORTED',
    )
  })
  it('bounds matches and whole unscoped conditions instead of omitting them', async () => {
    const s = source(51)
    const text = JSON.stringify({
      status: 'EVIDENCE_LOOKUP',
      anchor: { domain: 'PLACE', predicates: [{ field: 'kind', equals: 'SHOP' }] },
      unresolved: ['today'],
    })
    expect((await run(s, text)).status).toBe('BASELINE')
    const big = graph()
    big.directory.knowledge[big.directory.knowledge.length - 1]!.content = 'x'.repeat(31000)
    expect((await run(big)).status).toBe('BASELINE')
  })
  it('rejects stale/mutated source and forged compiler ownership', () => {
    const s = graph(),
      c = compileGuestQueryCanonicalSource(s)
    s.directory.knowledge[0]!.content += ' changed'
    expect(() => guestCanonicalEvidenceAuthority(c.prepared, s)).toThrow()
    expect(() => guestCanonicalEvidenceAuthority({ ...c.prepared }, graph())).toThrow()
  })
  it('ignores mutations to public scope metadata and returned private-proof copies', () => {
    const s = graph(),
      c = compileGuestQueryCanonicalSource(s)
    c.knowledgeScopes.length = 0
    const proof = guestCanonicalEvidenceAuthority(c.prepared, s)
    proof.knowledgeScopes.length = 0
    expect(guestCanonicalEvidenceAuthority(c.prepared, s).knowledgeScopes.length).toBeGreaterThan(0)
    const q = c.prepared.validateQuery({
      ...c.prepared.scope,
      mode: 'list',
      domain: 'PLACE',
      predicates: [{ field: 'product', name: 'Comet kit' }],
    })
    const admit = prepareGuestKnowledgeAdmission(s, c, q)
    const row = s.directory.knowledge.find((x) => x.id === 'a-service')!
    expect(admit({ ...row, content: row.content + ' extra restriction' })).toBe('RETAIN')
  })
  it('retains selected known subject at 10k scoped sources without readding unrelated aliases', async () => {
    const s = source(10000)
    for (let i = 0; i < 10000; i++)
      append(
        s,
        `service-${i}`,
        {
          kind: 'SERVICE',
          name: `Service ${i}`,
          placeId: `p${i}`,
          description: `Whole scope for place ${i}; age restrictions are conditional.`,
        },
        true,
      )
    const text = JSON.stringify({
      status: 'EVIDENCE_LOOKUP',
      anchor: { domain: 'PLACE', predicates: [{ field: 'name', equals: 'Fiction Counter 0' }] },
      unresolved: ['under eight'],
    })
    const r = await run(s, text, 'Can Fiction Counter 0 accommodate someone under eight?')
    expect(r.status).toBe('READY')
    if (r.status !== 'READY') return
    expect(r.prompt).toContain('Whole scope for place 0')
    expect(r.prompt).not.toContain('Whole scope for place 9999')
    expect(r.summary).toMatchObject({ scopedAliasOmissionCount: 9999 })
    expect(r.knowledge).toHaveLength(1)
    expect(r.canonicalSources).toHaveLength(0)
  })
  it('preserves existing default-off/native gate', () => {
    for (const nativePath of ['NATIVE', 'LEGACY'])
      expect(
        guestQueryChatExperimentEnabled({
          nodeEnv: 'production',
          enabled: '1',
          experienceScope: 'PUBLIC',
          nativePath,
        }),
      ).toBe(false)
    expect(
      guestQueryChatExperimentEnabled({
        nodeEnv: 'test',
        enabled: '1',
        experienceScope: 'PUBLIC',
        nativePath: 'NATIVE',
      }),
    ).toBe(false)
  })
  it('retains a whole privately scoped service even without a materialized Knowledge alias', async () => {
    const s = source(1)
    append(s, 'solo-service', {
      kind: 'SERVICE',
      name: 'Whole service',
      placeId: 'p0',
      description: 'At least nine years old; an adult must remain.',
    })
    const r = await run(
      s,
      JSON.stringify({
        status: 'EVIDENCE_LOOKUP',
        anchor: { domain: 'PLACE', predicates: [{ field: 'kind', equals: 'SHOP' }] },
        unresolved: ['today'],
      }),
    )
    expect(r.status).toBe('READY')
    if (r.status === 'READY') {
      expect(r.prompt).toContain('At least nine years old; an adult must remain.')
      expect(r.canonicalSources).toHaveLength(1)
    }
  })
  it('does not let a caller forge an omission for a generic unscoped policy', () => {
    const s = graph()
    const m = append(
      s,
      'generic-policy',
      {
        kind: 'POLICY',
        title: 'Generic visitor rule',
        rule: 'All visitors must ask staff for conditions.',
        appliesTo: ['visitors'],
      },
      true,
    )
    const c = compileGuestQueryCanonicalSource(s)
    c.knowledgeScopes.push({ disposition: 'FULLY_SCOPED', snapshot: m, placeKeys: ['place:p1'] })
    c.relatedKeysByPlace['place:p0'] = []
    const q = c.prepared.validateQuery({
      ...c.prepared.scope,
      domain: 'PLACE',
      mode: 'list',
      predicates: [{ field: 'product', name: 'Comet kit' }],
    })
    expect(
      prepareGuestKnowledgeAdmission(
        s,
        c,
        q,
      )(s.directory.knowledge.find((row) => row.id === 'a-generic-policy')!),
    ).toBe('RETAIN')
  })
  it('declines direct output if a caller removes the public canonical closure before alias omission', () => {
    const s = graph(),
      c = compileGuestQueryCanonicalSource(s)
    c.relatedKeysByPlace['place:p0'] = []
    const query = c.prepared.validateQuery({
      ...c.prepared.scope,
      domain: 'PLACE',
      mode: 'list',
      predicates: [{ field: 'product', name: 'Comet kit' }],
    })
    expect(formatGuestQueryDirectAnswer({ source: s, compiled: c, query }).status).toBe(
      'UNSUPPORTED',
    )
  })
  it('retains absent-alias global policy and tainted product bodies as unknown-scope evidence', async () => {
    const s = source(1)
    append(s, 'global-rule', {
      kind: 'POLICY',
      title: 'Visitor rule',
      rule: 'Global warning: no refunds; ask staff about age.',
      appliesTo: ['visitors'],
    })
    append(s, 'duplicate-a', {
      kind: 'ITEM',
      name: 'Twin kit',
      itemType: 'PRODUCT',
      description: 'First conflicting item requires an adult.',
    })
    append(s, 'duplicate-b', {
      kind: 'ITEM',
      name: 'Twin kit',
      itemType: 'PRODUCT',
      description: 'Second conflicting item requires separate payment.',
    })
    const text = JSON.stringify({
      status: 'EVIDENCE_LOOKUP',
      anchor: { domain: 'PLACE', predicates: [{ field: 'kind', equals: 'SHOP' }] },
      unresolved: ['today'],
    })
    const r = await run(s, text)
    expect(r.status).toBe('READY')
    if (r.status === 'READY') {
      for (const condition of [
        'Global warning: no refunds',
        'First conflicting item requires an adult',
        'Second conflicting item requires separate payment',
      ])
        expect(r.prompt).toContain(condition)
      expect(r.summary.policyCoverage).toBe('UNKNOWN')
    }
  })
  it('does not use a global body to fabricate positive subject evidence for a zero-known anchor', async () => {
    const s = source(0)
    append(s, 'global-only', {
      kind: 'POLICY',
      title: 'Global',
      rule: 'Ask staff for all visitor conditions.',
      appliesTo: [],
    })
    expect((await run(s)).status).toBe('BASELINE')
  })
  it('retains unsupported-kind whole source bodies rather than silently dropping their conditions', async () => {
    const s = source(1)
    append(s, 'fact', {
      kind: 'OPERATIONAL_FACT',
      label: 'Visitor notice',
      value: 'Equipment is never included; ask staff.',
    })
    const r = await run(
      s,
      JSON.stringify({
        status: 'EVIDENCE_LOOKUP',
        anchor: { domain: 'PLACE', predicates: [{ field: 'kind', equals: 'SHOP' }] },
        unresolved: ['today'],
      }),
    )
    expect(r.status).toBe('READY')
    if (r.status === 'READY') expect(r.prompt).toContain('Equipment is never included; ask staff.')
  })
  it('excludes unrelated valid governed edges by private complete endpoint scope, not prose', async () => {
    const s = source(120)
    for (let i = 0; i < 120; i++) {
      append(
        s,
        `counter-${i}`,
        {
          kind: 'SERVICE',
          name: `Counter service ${i}`,
          placeId: `p${i}`,
          description: `Full service condition ${i}.`,
        },
        true,
      )
      append(
        s,
        `kit-${i}`,
        {
          kind: 'ITEM',
          name: `Fiction kit ${i}`,
          itemType: 'PRODUCT',
          description: `Full item condition ${i}.`,
        },
        true,
      )
      append(s, `edge-${i}`, {
        kind: 'RELATIONSHIP',
        fromModuleId: `counter-${i}`,
        toModuleId: `kit-${i}`,
        relationshipType: 'OFFERS_PRODUCT_V1',
        description: `Offering condition ${i}.`,
      })
    }
    const r = await run(
      s,
      JSON.stringify({
        status: 'EVIDENCE_LOOKUP',
        anchor: { domain: 'PLACE', predicates: [{ field: 'product', name: 'Fiction kit 0' }] },
        unresolved: ['today'],
      }),
      'Where is Fiction kit 0 available today?',
    )
    expect(r.status).toBe('READY')
    if (r.status === 'READY') {
      expect(r.canonicalSources.map((x) => x.moduleId)).toContain('edge-0')
      expect(r.prompt).toContain('Offering condition 0.')
      expect(r.prompt).not.toContain('Offering condition 119.')
      expect(r.summary).toMatchObject({ anchorUnknownCandidateCount: 119 })
    }
  })
})
