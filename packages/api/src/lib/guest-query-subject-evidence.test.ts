import { describe, expect, it } from 'vitest'
import type { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'
import { compileGuestQueryCanonicalSource, guestCanonicalEvidenceAuthority } from './guest-query-canonical-projection'
import { guestCanonicalAliasBody } from './guest-query-whole-sources'
import { prepareGuestChatQueryExperiment } from './guest-query-chat-experiment'
import { prepareGuestSubjectEvidence } from './guest-query-subject-evidence'
import { parseGuestQueryPlan } from './guest-query-planning'
import type { GuestQuerySource } from './guest-query-source'

function source(): GuestQuerySource {
  return { tenantId: 'fiction-tenant', venueId: 'fiction-venue', version: 'v1', asOf: '2026-10-21T05:00:00.000Z', coverage: 'COMPLETE', includeSecondLayer: false, readPath: 'LEGACY',
    directory: { incomplete: false, searchVersion: 'v1', knowledge: [], places: ['a', 'b'].map(id => ({ id, name: `Public hall ${id}`, type: 'SHOP', itemType: null, shortDescription: null, longDescription: 'Whole public place conditions.', lat: null, lng: null, tags: [], areaName: null, hours: null, photoUrl: null, sourceType: 'MANUAL', sourceName: null, sourceUrl: null })) }, canonicalModules: { contract: 'published-query-source-v1', modules: [] } }
}
function append(s: GuestQuerySource, id: string, payload: GeneralizedContentPayload, alias = true) {
  const m = { moduleId: id, revisionId: `r-${id}`, publicationId: `pub-${id}`, publicationOrder: String(s.canonicalModules!.modules.length + 1), kind: payload.kind, version: 1, payload, audience: 'PUBLIC' as const, effectiveFrom: null, effectiveUntil: null, evidence: [] }
  s.canonicalModules!.modules.push(m)
  const body = guestCanonicalAliasBody(m)
  if (alias && body) s.directory.knowledge.push({ id: `alias-${id}`, title: body.title, category: m.kind, content: body.content, sourceType: 'UNIVERSAL_CONTENT', sourceName: null, sourceUrl: null, contentModuleId: id, contentRevisionId: m.revisionId, contentPublicationId: m.publicationId })
  return m
}
function graph() {
  const s = source()
  append(s, 'product', { kind: 'ITEM', itemType: 'PRODUCT', name: 'Comet token', description: 'Sealed token; stock unknown.', placeId: 'b' })
  append(s, 'service-a', { kind: 'SERVICE', name: 'Aurora service', placeId: 'a', description: 'Children stay with an adult.', availability: 'Weekends only; confirm staffing.' })
  append(s, 'service-b', { kind: 'SERVICE', name: 'Borealis service', placeId: 'b', description: 'Bring a valid licence.', availability: 'Evenings only; no festival dates.' })
  append(s, 'offer', { kind: 'RELATIONSHIP', fromModuleId: 'service-a', toModuleId: 'product', relationshipType: 'OFFERS_PRODUCT_V1', description: 'Explicit listed offer; stock is not guaranteed.' })
  append(s, 'policy-a', { kind: 'POLICY', title: 'Aurora condition', rule: 'No refunds; minimum age nine.', appliesTo: ['service-a'] }, false)
  append(s, 'policy-b', { kind: 'POLICY', title: 'Borealis condition', rule: 'Deposit required only for Borealis.', appliesTo: ['service-b'] })
  return s
}
function subjects(s: GuestQuerySource, names: string[], question = `Full details for ${names.join(' and ')} please.`) {
  const p = compileGuestQueryCanonicalSource(s).prepared, catalog = p.discoverNamedCandidates(question)
  const refs = names.map(name => p.namedCatalogData(catalog, question).groups.find(g => g.record?.name === name)!.ref)
  return prepareGuestChatQueryExperiment({ source: s, question, directAnswer: true, interpret: async () => JSON.stringify({ status: 'EVIDENCE_SUBJECTS', refs }) })
}
describe('whole named subject evidence', () => {
  it('retains SERVICE availability, its visible place, scoped policy without alias and valid offer', async () => {
    const s = graph(), other = s.canonicalModules!.modules.find(m => m.moduleId === 'service-b')!
    if (other.payload.kind !== 'SERVICE') throw Error('fixture')
    other.payload.placeId = 'a' // co-location does not make its distinct policy apply to Aurora
    const r = await subjects(s, ['Aurora service'])
    expect(r.status).toBe('READY'); if (r.status !== 'READY') return
    for (const text of ['Weekends only; confirm staffing.', 'No refunds; minimum age nine.', 'Explicit listed offer', 'Public hall a']) expect(r.prompt).toContain(text)
    expect(r.canonicalSources.map(b => b.moduleId)).toContain('policy-a')
    expect(r.prompt).not.toContain('Deposit required only for Borealis.')
    expect(r.summary).toMatchObject({ mode: 'DETAILS', eligibilityEvaluated: false, qualifiedCountAvailable: false, unresolvedConstraints: [] })
  })
  it('unions two explicitly named subjects without evaluating an OR filter or erasing separate scope', async () => {
    const r = await subjects(graph(), ['Aurora service', 'Borealis service'])
    expect(r.status).toBe('READY'); if (r.status !== 'READY') return
    for (const text of ['Weekends only', 'Evenings only', 'No refunds', 'Deposit required only for Borealis']) expect(r.prompt).toContain(text)
    expect(r.places.map(p => p.id).sort()).toEqual(['a', 'b'])
    expect(r.prompt).not.toContain('exactEligibleCount')
  })
  it('product metadata expands only actual offers, not ITEM.placeId, and preserves zero-offer uncertainty', async () => {
    const s = graph(), offered = await subjects(s, ['Comet token'])
    expect(offered.status).toBe('READY'); if (offered.status !== 'READY') return
    expect(offered.places.map(p => p.id)).toEqual(['a'])
    expect(offered.prompt).toContain('Aurora service'); expect(offered.prompt).not.toContain('Evenings only')
    s.canonicalModules!.modules = s.canonicalModules!.modules.filter(m => m.moduleId !== 'offer')
    const absent = await subjects(s, ['Comet token'])
    expect(absent.status).toBe('READY'); if (absent.status !== 'READY') return
    expect(absent.places).toEqual([])
    expect(('subjectStatus' in absent.summary ? absent.summary.subjectStatus : undefined)).toContainEqual(expect.objectContaining({ offeringEvidence: 'NO_EXPLICIT_RESOLVED_OFFERS_ESTABLISHED', purchaseAndStock: 'UNKNOWN' }))
    expect(absent.prompt).toContain('Sealed token; stock unknown.')
  })
  it('keeps public service facts with unresolved hidden location and never hydrates its name', async () => {
    const s = graph(); s.directory.places = s.directory.places.filter(p => p.id !== 'a')
    const r = await subjects(s, ['Aurora service'])
    expect(r.status).toBe('READY'); if (r.status !== 'READY') return
    expect(r.prompt).toContain('Weekends only'); expect(r.prompt).not.toContain('Public hall a')
    expect(r.places.every(p => p.id !== 'a')).toBe(true)
    expect(('subjectStatus' in r.summary ? r.summary.subjectStatus : undefined)).toContainEqual(expect.objectContaining({ moduleId: 'service-a', location: 'UNRESOLVED_IN_CURRENT_GUIDE' }))
    expect(r.prompt).toContain('Do not invent a location')
  })
  it('keeps updated policy only and does not resurrect a withdrawn policy', async () => {
    const s = graph(), policy = s.canonicalModules!.modules.find(m => m.moduleId === 'policy-a')!
    if (policy.payload.kind !== 'POLICY') throw Error('fixture')
    policy.payload.rule = 'Updated: an adult must book ahead.'
    const updated = await subjects(s, ['Aurora service'])
    expect(updated.status).toBe('READY'); if (updated.status !== 'READY') return
    expect(updated.prompt).toContain('Updated: an adult must book ahead.'); expect(updated.prompt).not.toContain('minimum age nine')
    s.canonicalModules!.modules = s.canonicalModules!.modules.filter(m => m !== policy)
    const withdrawn = await subjects(s, ['Aurora service'])
    expect(withdrawn.status).toBe('READY'); if (withdrawn.status === 'READY') expect(withdrawn.prompt).not.toContain('Updated: an adult must book ahead.')
  })
  it('retains unknown/global/tainted and manual bodies without inventing applicability', async () => {
    const s = graph()
    append(s, 'global', { kind: 'POLICY', title: 'Global notice', rule: 'Special closures may apply.', appliesTo: [] }, false)
    append(s, 'unresolved', { kind: 'POLICY', title: 'Unknown target', rule: 'Unresolved condition remains whole.', appliesTo: ['missing'] }, false)
    s.directory.knowledge.push({ id: 'manual', title: 'Manual note', category: 'VISIT', content: 'Operator caution remains whole.', sourceType: 'MANUAL', sourceName: null, sourceUrl: null })
    const r = await subjects(s, ['Aurora service'])
    expect(r.status).toBe('READY'); if (r.status !== 'READY') return
    for (const text of ['Special closures may apply.', 'Unresolved condition remains whole.', 'Operator caution remains whole.']) expect(r.prompt).toContain(text)
    expect(r.summary.policyCoverage).toBe('UNKNOWN')
  })
  it('keeps whole exception chains at exact module scope and does not certify disjoint scopes', async () => {
    const s = graph()
    append(s, 'exception', { kind: 'POLICY', title: 'Scoped exception', rule: 'Reserved groups may use the stated alternative.', appliesTo: [] }, false)
    append(s, 'exception-edge', { kind: 'RELATIONSHIP', fromModuleId: 'exception', toModuleId: 'policy-a', relationshipType: 'EXCEPTION_TO_V1' }, false)
    const r = await subjects(s, ['Aurora service'])
    expect(r.status).toBe('READY'); if (r.status !== 'READY') return
    expect(r.canonicalSources.map(b => b.moduleId)).toEqual(expect.arrayContaining(['policy-a', 'exception', 'exception-edge']))
    const exception = s.canonicalModules!.modules.find(m => m.moduleId === 'exception')!
    if (exception.payload.kind !== 'POLICY') throw Error('fixture')
    exception.payload.appliesTo = ['service-b']
    const c = compileGuestQueryCanonicalSource(s), proof = guestCanonicalEvidenceAuthority(c.prepared, s)
    expect(proof.subjectPolicyScopes.some(p => p.moduleId === 'exception')).toBe(false)
    const disjoint = await subjects(s, ['Aurora service'])
    expect(disjoint.status).toBe('READY'); if (disjoint.status !== 'READY') return
    expect(disjoint.prompt).toContain('Reserved groups may use the stated alternative.')
    expect(disjoint.summary.policyCoverage).toBe('UNKNOWN')
  })
  it('does not place expired operational facts in subject authority', async () => {
    const s = graph()
    append(s, 'expired', { kind: 'OPERATIONAL_FACT', label: 'Past notice', value: 'EXPIRED_MUST_NOT_APPEAR', expiresAt: '2026-10-20T00:00:00.000Z' }, false)
    const r = await subjects(s, ['Aurora service'])
    expect(r.status).toBe('READY'); if (r.status === 'READY') expect(r.prompt).not.toContain('EXPIRED_MUST_NOT_APPEAR')
  })
  it('fails closed when the selected canonical alias body or binding is not current', async () => {
    const s = graph(); s.directory.knowledge.find(k => k.id === 'alias-service-a')!.content += ' unproven edit'
    expect((await subjects(s, ['Aurora service'])).status).toBe('BASELINE')
  })
  it('rejects mutation/cross-snapshot authority and ignores public scope-map mutations', () => {
    const s = graph(), c = compileGuestQueryCanonicalSource(s)
    c.relatedKeysByPlace = {}; c.knowledgeScopes.length = 0
    guestCanonicalEvidenceAuthority(c.prepared, s).subjectOffers.length = 0
    const result = prepareGuestSubjectEvidence({ source: s, compiled: c, keys: ['knowledge:alias-service-a'], mode: 'DETAILS' })
    expect(result.prompt).toContain('No refunds')
    const changed = structuredClone(s); changed.directory.knowledge[0]!.content += ' drift'
    expect(() => prepareGuestSubjectEvidence({ source: changed, compiled: c, keys: ['knowledge:alias-service-a'], mode: 'DETAILS' })).toThrow(/authority/)
  })
  it('bounds whole bodies without truncation', async () => {
    const s = graph(); s.directory.knowledge.push({ id: 'large', title: 'Unscoped', category: 'VISIT', content: 'x'.repeat(30001), sourceType: 'MANUAL', sourceName: null, sourceUrl: null })
    expect((await subjects(s, ['Aurora service'])).status).toBe('BASELINE')
  })
  it('rejects duplicate, unmentioned, extra-field and ambiguous subject refs', () => {
    const s = graph(), p = compileGuestQueryCanonicalSource(s).prepared, question = 'Aurora service details', names = { question, catalog: p.discoverNamedCandidates(question) }
    for (const plan of [{ status: 'EVIDENCE_SUBJECTS', refs: [] }, { status: 'EVIDENCE_SUBJECTS', refs: ['n0', 'n0'] }, { status: 'EVIDENCE_SUBJECTS', refs: ['n99'] }, { status: 'EVIDENCE_SUBJECTS', refs: ['n0'], answer: 'invented' }]) expect(() => parseGuestQueryPlan(JSON.stringify(plan), p, names)).toThrow()
    s.directory.knowledge[1]!.title = s.directory.knowledge[0]!.title
    const other = compileGuestQueryCanonicalSource(s).prepared, q = 'Comet token details'
    expect(() => parseGuestQueryPlan('{"status":"EVIDENCE_SUBJECTS","refs":["n0"]}', other, { question: q, catalog: other.discoverNamedCandidates(q) })).toThrow()
  })
  it('routes QUERY Knowledge lists through the same normal evidence path, preserving PLACE count/seller DIRECT', async () => {
    const s = graph(), run = (plan: unknown, question: string) => prepareGuestChatQueryExperiment({ source: s, question, directAnswer: true, interpret: async () => JSON.stringify(plan) })
    expect((await run({ status: 'QUERY', mode: 'list', domain: 'KNOWLEDGE', predicates: [{ field: 'name', equals: 'Aurora service' }] }, 'Aurora service details')).status).toBe('READY')
    expect((await run({ status: 'QUERY', mode: 'count', domain: 'PLACE', predicates: [{ field: 'kind', equals: 'SHOP' }] }, 'How many stored shops?')).status).toBe('DIRECT_READY')
    expect((await run({ status: 'QUERY', mode: 'list', domain: 'PLACE', predicates: [{ field: 'product', name: 'Comet token' }] }, 'Which places offer Comet token?')).status).toBe('DIRECT_READY')
  })
})
