import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  OperationalFactContentDraft,
  type GeneralizedContentPayload,
  type OperationalFactApplicability,
} from '@pathfinder/contracts/universal-content-actions'
import {
  compileGuestQueryCanonicalSource,
  guestCanonicalEvidenceAuthority,
} from './guest-query-canonical-projection'
import { createGuestQueryCompileCache } from './guest-query-compile-cache'
import { prepareGuestQueryEvidence } from './guest-query-evidence'
import { prepareGuestSubjectEvidence } from './guest-query-subject-evidence'
import { guestCanonicalAliasBody } from './guest-query-whole-sources'
import type { GuestQuerySource } from './guest-query-source'

// Fictional venue data only. Every body below is kept byte-for-byte; assertions compare whole
// bodies and exact source keys, never loose fragments.
const AS_OF = '2026-10-21T05:00:00.000Z'

function place(id: string, name: string) {
  return {
    id,
    name,
    type: 'ATTRACTION',
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
  }
}

function venue(places: Array<[string, string]> = []): GuestQuerySource {
  return {
    tenantId: 'fiction-tenant',
    venueId: 'fiction-venue',
    version: '',
    asOf: AS_OF,
    coverage: 'COMPLETE',
    includeSecondLayer: false,
    readPath: 'LEGACY',
    directory: {
      incomplete: false,
      searchVersion: '',
      knowledge: [],
      places: places.map(([id, name]) => place(id, name)),
    },
    canonicalModules: { contract: 'published-query-source-v1', modules: [] },
  }
}

function add(
  s: GuestQuerySource,
  id: string,
  payload: GeneralizedContentPayload,
  options: { revision?: string; effectiveUntil?: string | null } = {},
) {
  const revision = options.revision ?? '1'
  const m = {
    moduleId: id,
    revisionId: `r${revision}-${id}`,
    publicationId: `p${revision}-${id}`,
    publicationOrder: String(s.canonicalModules!.modules.length + 1),
    kind: payload.kind,
    version: Number(revision),
    payload,
    audience: 'PUBLIC' as const,
    effectiveFrom: null,
    effectiveUntil: options.effectiveUntil ?? null,
    evidence: [],
  }
  s.canonicalModules!.modules.push(m)
  const body = guestCanonicalAliasBody(m)
  if (body)
    s.directory.knowledge.push({
      id: `alias-${id}`,
      title: body.title,
      category: m.kind,
      content: body.content,
      sourceType: 'UNIVERSAL_CONTENT',
      sourceName: null,
      sourceUrl: null,
      contentModuleId: id,
      contentRevisionId: m.revisionId,
      contentPublicationId: m.publicationId,
    })
  return m
}

/** Stand-in for the loader's content-derived version over the exact admitted rows. */
function seal(s: GuestQuerySource) {
  const { version: _v, directory, ...rest } = s
  void _v
  const version = createHash('sha256')
    .update(JSON.stringify({ ...rest, directory: { ...directory, searchVersion: '' } }))
    .digest('hex')
  s.version = version
  s.directory.searchVersion = version
  return s
}

const service = (name: string, placeId: string | null): GeneralizedContentPayload => ({
  kind: 'SERVICE',
  name,
  placeId,
  description: null,
  availability: null,
})
const fact = (
  label: string,
  value: string,
  applicability?: OperationalFactApplicability,
): GeneralizedContentPayload =>
  OperationalFactContentDraft.parse({
    kind: 'OPERATIONAL_FACT',
    label,
    value,
    ...(applicability ? { applicability } : {}),
  })
const subjects = (subjectModuleIds: string[], placeIds: string[] = []) =>
  ({ scope: 'SUBJECTS', subjectModuleIds, placeIds }) as const
const VENUE = { scope: 'VENUE' } as const

function certification(s: GuestQuerySource) {
  const compiled = compileGuestQueryCanonicalSource(s)
  return {
    certified: guestCanonicalEvidenceAuthority(compiled.prepared, s).subjectFactApplicability,
    rejected: compiled.factApplicabilityRejections,
  }
}
function evidence(
  s: GuestQuerySource,
  roots: string[],
  options: { mode?: 'DETAILS' | 'CONDITIONAL'; unresolved?: string[] } = {},
) {
  return prepareGuestSubjectEvidence({
    source: s,
    compiled: compileGuestQueryCanonicalSource(s),
    keys: roots.map((id) => `knowledge:alias-${id}`),
    mode: options.mode ?? 'DETAILS',
    unresolved: options.unresolved,
  })
}
const canonicalIds = (result: ReturnType<typeof evidence>) =>
  result.canonicalSources.map((body) => body.moduleId).sort()
const aliasIds = (result: ReturnType<typeof evidence>) =>
  result.knowledge.map((topic) => topic.id).sort()

const BODY = {
  wheelHours: 'Moonwheel operates 11:00 to 19:00 on Saturdays.',
  wheelPrice: 'A Moonwheel ride costs $5 per person.',
  skiff: 'River Skiff is closed on October 24 for track maintenance.',
  arcade: 'Lantern Arcade has covered indoor seating.',
  square: 'Lantern Square is open while the park admits visitors.',
  parkHours: 'The park admits visitors 10:00 to 20:00 on Saturdays.',
  tap: 'A free drinking-water tap is beside the bridge.',
}

function park(declared = true) {
  const s = venue([
    ['square', 'Lantern Square'],
    ['dock', 'River Dock'],
    ['arcade', 'Lantern Arcade'],
  ])
  add(s, 'moonwheel', service('Moonwheel', 'square'))
  add(s, 'skiff', service('River Skiff', 'dock'))
  add(s, 'kitchen', service('Lantern Kitchen', 'square'))
  const d = <T>(value: T) => (declared ? value : undefined)
  add(s, 'f-wheel-hours', fact('Moonwheel schedule', BODY.wheelHours, d(subjects(['moonwheel']))))
  add(s, 'f-wheel-price', fact('Moonwheel tickets', BODY.wheelPrice, d(subjects(['moonwheel']))))
  add(s, 'f-skiff', fact('River Skiff closure', BODY.skiff, d(subjects(['skiff']))))
  add(s, 'f-arcade', fact('Rain shelter', BODY.arcade, d(subjects([], ['arcade']))))
  add(s, 'f-square', fact('Square access', BODY.square, d(subjects([], ['square']))))
  add(s, 'f-park', fact('Saturday hours', BODY.parkHours, d(VENUE)))
  add(s, 'f-tap', fact('Water refill', BODY.tap))
  return seal(s)
}

describe('authored fact applicability contract', () => {
  it('accepts VENUE, SUBJECTS and absence; refuses empty, duplicate or extra fields', () => {
    const base = { kind: 'OPERATIONAL_FACT', label: 'L', value: 'V' }
    expect(OperationalFactContentDraft.safeParse(base).success).toBe(true)
    expect(OperationalFactContentDraft.safeParse({ ...base, applicability: VENUE }).success).toBe(
      true,
    )
    expect(
      OperationalFactContentDraft.safeParse({ ...base, applicability: subjects(['a'], ['p']) })
        .success,
    ).toBe(true)
    for (const applicability of [
      { scope: 'SUBJECTS' },
      subjects([]),
      subjects(['a', 'a']),
      subjects([], ['p', 'p']),
      { scope: 'VENUE', subjectModuleIds: ['a'] },
      { scope: 'SUBJECTS', subjectModuleIds: ['a'], complete: true },
      { scope: 'GLOBAL' },
    ])
      expect(OperationalFactContentDraft.safeParse({ ...base, applicability }).success).toBe(false)
  })
})

describe('compiler certification of fact applicability', () => {
  it('certifies exact current revision/publication; VENUE certifies but never omits', () => {
    const s = park()
    const { certified, rejected } = certification(s)
    expect(rejected).toEqual([])
    expect(certified).toContainEqual({
      moduleId: 'f-skiff',
      revisionId: 'r1-f-skiff',
      publicationId: 'p1-f-skiff',
      scope: 'SUBJECTS',
      subjectModuleIds: ['skiff'],
      placeIds: [],
    })
    expect(certified).toContainEqual({
      moduleId: 'f-park',
      revisionId: 'r1-f-park',
      publicationId: 'p1-f-park',
      scope: 'VENUE',
    })
    expect(certified.some((c) => c.moduleId === 'f-tap')).toBe(false)
  })

  it.each([
    ['a missing module', subjects(['gone'])],
    ['a POLICY module', subjects(['policy'])],
    ['another fact', subjects(['f-other'])],
    ['an expired subject', subjects(['retired'])],
    ['a hidden place', subjects([], ['hidden-place'])],
  ])('refuses %s as a target', (_label, applicability) => {
    const s = venue([['square', 'Lantern Square']])
    add(s, 'policy', { kind: 'POLICY', title: 'Rule', rule: 'No glass.', appliesTo: [] })
    add(s, 'f-other', fact('Other', 'Another note.'))
    add(s, 'retired', service('Old Carousel', 'square'), { effectiveUntil: AS_OF })
    add(s, 'f', fact('Note', 'Opens at noon.', applicability))
    const { certified, rejected } = certification(seal(s))
    expect(certified.some((c) => c.moduleId === 'f')).toBe(false)
    expect(rejected).toContainEqual({ moduleId: 'f', reason: 'TARGET_NOT_CURRENT_PUBLIC_SUBJECT' })
  })

  it('refuses a target whose name is not unique among current subjects and places', () => {
    const s = venue([['hall', 'Explorer Hall']])
    add(s, 'display', { kind: 'ITEM', itemType: 'EXHIBIT', name: 'Explorer', placeId: 'hall' })
    add(s, 'vessel', service('Explorer', null))
    add(s, 'f', fact('Explorer display hours', 'Open until 8.', subjects(['display'])))
    expect(certification(seal(s)).rejected).toEqual([
      { moduleId: 'f', reason: 'AMBIGUOUS_TARGET_NAME' },
    ])
  })

  it('refuses a body naming any undeclared current subject or place, case-insensitively', () => {
    for (const value of [
      'Kitchen staff also sell MOONWHEEL tickets.',
      'Queue at River Dock for boarding.',
      'Lantern Kitchen sits beside Lantern Square.',
    ]) {
      const s = park()
      add(s, 'f', fact('Kitchen note', value, subjects(['kitchen'])))
      expect(certification(seal(s)).rejected).toContainEqual({
        moduleId: 'f',
        reason: 'MENTIONS_UNDECLARED_SUBJECT',
      })
    }
  })

  it('uses whole-word name boundaries like the name catalog and allows declared names', () => {
    const s = park()
    add(
      s,
      'f',
      fact('Kitchen note', 'Lantern Kitchen serves Moonwheelers first.', subjects(['kitchen'])),
    )
    add(
      s,
      'g',
      fact(
        'Shared ticket',
        'Moonwheel and River Skiff share one queue.',
        subjects(['moonwheel', 'skiff']),
      ),
    )
    const { certified, rejected } = certification(seal(s))
    expect(rejected).toEqual([])
    expect(certified.map((c) => c.moduleId)).toEqual(expect.arrayContaining(['f', 'g']))
  })

  it.each([
    'During lightning, every outdoor ride closes.',
    'The rest of the park follows its usual schedule.',
    'Glass is prohibited throughout the grounds.',
    'Strollers are not allowed on any ride.',
    'A park-wide closure applies on storm days.',
  ])('refuses venue-wide wording in a SUBJECTS body: %s', (value) => {
    const s = park()
    add(s, 'f', fact('Moonwheel weather', value, subjects(['moonwheel'])))
    expect(certification(seal(s)).rejected).toContainEqual({
      moduleId: 'f',
      reason: 'VENUE_WIDE_WORDING',
    })
  })

  it('does not certify a fact that is itself expired', () => {
    const s = park()
    add(
      s,
      'f-old',
      OperationalFactContentDraft.parse({
        kind: 'OPERATIONAL_FACT',
        label: 'Old Moonwheel offer',
        value: 'Moonwheel was free during opening week.',
        expiresAt: AS_OF,
        applicability: subjects(['moonwheel']),
      }),
    )
    const { certified, rejected } = certification(seal(s))
    expect([...certified, ...rejected].some((row) => row.moduleId === 'f-old')).toBe(false)
  })
})

describe('whole-body omission under certified applicability', () => {
  it('keeps the named subject, its facts, place facts, VENUE and unknown facts whole', () => {
    const s = park()
    const result = evidence(s, ['moonwheel'])
    expect(canonicalIds(result)).toEqual([
      'f-park',
      'f-square',
      'f-tap',
      'f-wheel-hours',
      'f-wheel-price',
      'moonwheel',
    ])
    expect(aliasIds(result)).toEqual([
      'alias-f-park',
      'alias-f-square',
      'alias-f-tap',
      'alias-f-wheel-hours',
      'alias-f-wheel-price',
      'alias-moonwheel',
    ])
    for (const body of [BODY.wheelHours, BODY.wheelPrice, BODY.square, BODY.parkHours, BODY.tap])
      expect(result.prompt).toContain(JSON.stringify(body).slice(1, -1))
    for (const body of [BODY.skiff, BODY.arcade]) expect(result.prompt).not.toContain(body)
    expect(result.summary).toMatchObject({
      policyCoverage: 'UNKNOWN',
      eligibilityEvaluated: false,
      qualifiedCountAvailable: false,
      scopedAliasOmissionCount: 2,
      declaredFactApplicability: {
        omissionAllowed: true,
        omittedFactCount: 2,
        omittedFactAliasCount: 2,
      },
    })
  })

  it('with no declarations retains every fact and adds no applicability summary', () => {
    const result = evidence(park(false), ['moonwheel'])
    expect(canonicalIds(result)).toEqual([
      'f-arcade',
      'f-park',
      'f-skiff',
      'f-square',
      'f-tap',
      'f-wheel-hours',
      'f-wheel-price',
      'moonwheel',
    ])
    expect(result.summary).not.toHaveProperty('declaredFactApplicability')
  })

  it('a place-scoped fact follows its place, not the selected subject name', () => {
    expect(canonicalIds(evidence(park(), ['skiff']))).toEqual([
      'f-park',
      'f-skiff',
      'f-tap',
      'skiff',
    ])
    expect(canonicalIds(evidence(park(), ['kitchen']))).toContain('f-square')
  })

  it('omits nothing while the question has unresolved excerpts', () => {
    const result = evidence(park(), ['moonwheel'], {
      mode: 'CONDITIONAL',
      unresolved: ['somewhere dry to wait'],
    })
    expect(canonicalIds(result)).toEqual(expect.arrayContaining(['f-arcade', 'f-skiff']))
    expect(result.summary).toMatchObject({
      declaredFactApplicability: { omissionAllowed: false, omittedFactCount: 0 },
    })
  })

  it('a fact root keeps itself and turns omission off: it names no typed subject', () => {
    const result = evidence(park(), ['moonwheel', 'f-skiff'])
    expect(canonicalIds(result)).toEqual(expect.arrayContaining(['f-skiff', 'f-arcade']))
    expect(result.summary).toMatchObject({
      declaredFactApplicability: { omissionAllowed: false, omittedFactCount: 0 },
    })
  })

  it('a manual Knowledge root turns omission off: its subject has no typed identity', () => {
    // "River Skimmer" exists only as manual text, so the mention guard cannot see the name
    // inside the kitchen fact. Omitting relative to typed selections would drop that body.
    const s = park()
    add(
      s,
      'f-tokens',
      fact(
        'Kitchen tokens',
        'Lantern Kitchen meal tokens also work at River Skimmer.',
        subjects(['kitchen']),
      ),
    )
    s.directory.knowledge.push({
      id: 'manual-skimmer',
      title: 'River Skimmer',
      category: 'ATTRACTION',
      content: 'River Skimmer is the small boat ride.',
      sourceType: 'MANUAL',
      sourceName: null,
      sourceUrl: null,
    })
    seal(s)
    const result = prepareGuestSubjectEvidence({
      source: s,
      compiled: compileGuestQueryCanonicalSource(s),
      keys: ['knowledge:manual-skimmer'],
      mode: 'DETAILS',
    })
    expect(result.canonicalSources.map((b) => b.moduleId)).toContain('f-tokens')
    expect(result.summary).toMatchObject({
      declaredFactApplicability: { omissionAllowed: false, omittedFactCount: 0 },
    })
  })

  it('leaves structural records, counts, name ambiguity and policy scopes unchanged', () => {
    const plain = compileGuestQueryCanonicalSource(park(false)),
      scoped = compileGuestQueryCanonicalSource(park())
    const all = { domain: 'ALL', mode: 'list', predicates: [] } as const
    const rows = (c: typeof plain) =>
      c.prepared.evaluate({ ...c.prepared.scope, ...all }).page({ pageSize: 100 })
    expect(rows(scoped).knownMatchCount).toBe(rows(plain).knownMatchCount)
    expect(rows(scoped).rows.map((r) => r.key)).toEqual(rows(plain).rows.map((r) => r.key))
    expect(scoped.snapshot.records.map((r) => r.key)).toEqual(
      plain.snapshot.records.map((r) => r.key),
    )
    expect(scoped.unresolvedReasons).toEqual(plain.unresolvedReasons)
    const a = guestCanonicalEvidenceAuthority(plain.prepared, park(false)),
      b = guestCanonicalEvidenceAuthority(scoped.prepared, park())
    expect(b.subjectPolicyScopes).toEqual(a.subjectPolicyScopes)
    expect(b.subjectPolicyApplicability).toEqual(a.subjectPolicyApplicability)
    expect(b.lookupScopes.map((x) => x.snapshot.moduleId)).toEqual(
      a.lookupScopes.map((x) => x.snapshot.moduleId),
    )
  })
})

describe('the four mixed-scope counterexamples', () => {
  // Bodies copied exactly from qa/scope-omission-cases-01/proof.ts.
  const CASES = {
    lightning:
      'Moonwheel operates 10 to 6. During lightning, every outdoor attraction closes until staff clear reopening.',
    ticket:
      'Meal tokens are accepted here. Children under six enter Moonwheel free except during evening festivals; River Skiff always requires a separate ticket.',
    explorer:
      'Explorer is the indoor reconstruction display. The vessel outdoors is a separate experience; its deck closes at dusk, while this display remains open until 8.',
    admission:
      'Standard admission covers Moonwheel and River Skiff. River Skiff is excluded on school mornings; holders of the combined school pass may still enter.',
  }
  function world(
    label: string,
    body: string,
    applicability?: OperationalFactApplicability,
    explorerVesselName = 'Explorer deck tour',
  ) {
    const s = venue([
      ['square', 'Lantern Square'],
      ['dock', 'River Dock'],
      ['hall', 'Reconstruction Hall'],
    ])
    add(s, 'moonwheel', service('Moonwheel', 'square'))
    add(s, 'skiff', service('River Skiff', 'dock'))
    add(s, 'kitchen', service('Lantern Kitchen', 'square'))
    add(s, 'display', { kind: 'ITEM', itemType: 'EXHIBIT', name: 'Explorer', placeId: 'hall' })
    add(s, 'vessel', service(explorerVesselName, 'dock'))
    add(s, 'pass', { kind: 'ITEM', itemType: 'PRODUCT', name: 'Combined school pass' })
    add(s, 'mixed', fact(label, body, applicability))
    return seal(s)
  }
  const retainedFor = (s: GuestQuerySource, root: string) => {
    const result = evidence(s, [root])
    return canonicalIds(result).includes('mixed') && aliasIds(result).includes('alias-mixed')
  }

  it('global lightning rule: unknown or VENUE stays; a Moonwheel-only claim is refused', () => {
    expect(retainedFor(world('Moonwheel schedule', CASES.lightning), 'skiff')).toBe(true)
    expect(retainedFor(world('Moonwheel schedule', CASES.lightning, VENUE), 'skiff')).toBe(true)
    const misdeclared = world('Moonwheel schedule', CASES.lightning, subjects(['moonwheel']))
    expect(certification(misdeclared).rejected).toEqual([
      { moduleId: 'mixed', reason: 'VENUE_WIDE_WORDING' },
    ])
    expect(retainedFor(misdeclared, 'skiff')).toBe(true)
  })

  it('cross-subject ticket exception: complete claim reaches each named subject only', () => {
    const correct = world(
      'Lantern Kitchen tickets',
      CASES.ticket,
      subjects(['kitchen', 'moonwheel', 'skiff']),
    )
    expect(retainedFor(correct, 'moonwheel')).toBe(true)
    expect(retainedFor(correct, 'skiff')).toBe(true)
    expect(retainedFor(correct, 'display')).toBe(false)
    const misdeclared = world('Lantern Kitchen tickets', CASES.ticket, subjects(['kitchen']))
    expect(certification(misdeclared).rejected).toEqual([
      { moduleId: 'mixed', reason: 'MENTIONS_UNDECLARED_SUBJECT' },
    ])
    expect(retainedFor(misdeclared, 'moonwheel')).toBe(true)
  })

  it('display/vessel disambiguation: shared name refuses; complete claim retains for both', () => {
    const shared = world(
      'Explorer exhibit overview',
      CASES.explorer,
      subjects(['display']),
      'Explorer',
    )
    expect(certification(shared).rejected).toEqual([
      { moduleId: 'mixed', reason: 'AMBIGUOUS_TARGET_NAME' },
    ])
    expect(retainedFor(shared, 'vessel')).toBe(true)
    const complete = world(
      'Explorer exhibit overview',
      CASES.explorer,
      subjects(['display', 'vessel']),
    )
    expect(retainedFor(complete, 'vessel')).toBe(true)
    expect(retainedFor(complete, 'display')).toBe(true)
  })

  it('known limit: lexical guards are not proof; a plausible false claim is trusted', () => {
    // "the vessel" never names the vessel record, so no guard fires. Only authored review can
    // catch this. It is why declarations need an independent reviewer before publication.
    const falseClaim = world('Explorer exhibit overview', CASES.explorer, subjects(['display']))
    expect(certification(falseClaim).rejected).toEqual([])
    expect(retainedFor(falseClaim, 'vessel')).toBe(false)
  })

  it('ungrouped admission exception: unknown stays; complete claim reaches River Skiff', () => {
    expect(retainedFor(world('Venue admission conditions', CASES.admission), 'skiff')).toBe(true)
    const complete = world(
      'Venue admission conditions',
      CASES.admission,
      subjects(['moonwheel', 'skiff', 'pass']),
    )
    expect(retainedFor(complete, 'skiff')).toBe(true)
    const misdeclared = world(
      'Venue admission conditions',
      CASES.admission,
      subjects(['moonwheel']),
    )
    expect(certification(misdeclared).rejected).toEqual([
      { moduleId: 'mixed', reason: 'MENTIONS_UNDECLARED_SUBJECT' },
    ])
    expect(retainedFor(misdeclared, 'skiff')).toBe(true)
  })
})

describe('freshness: every compile re-checks the current source', () => {
  it('a withdrawn target leaves its fact unknown, so the fact returns to every evidence set', () => {
    const s = park()
    s.canonicalModules!.modules = s.canonicalModules!.modules.filter((m) => m.moduleId !== 'skiff')
    s.directory.knowledge = s.directory.knowledge.filter((k) => k.id !== 'alias-skiff')
    seal(s)
    expect(certification(s).rejected).toContainEqual({
      moduleId: 'f-skiff',
      reason: 'TARGET_NOT_CURRENT_PUBLIC_SUBJECT',
    })
    expect(canonicalIds(evidence(s, ['moonwheel']))).toContain('f-skiff')
  })

  it('a target that ends exactly at asOf certifies nothing', () => {
    const s = park()
    s.canonicalModules!.modules.find((m) => m.moduleId === 'skiff')!.effectiveUntil = AS_OF
    expect(canonicalIds(evidence(seal(s), ['moonwheel']))).toContain('f-skiff')
  })

  it('a newly published subject named in a body revokes that body omission authority', () => {
    const s = park()
    add(
      s,
      'f-scope',
      fact('Moonwheel view', 'Moonwheel looks over the Telescope.', subjects(['moonwheel'])),
    )
    expect(canonicalIds(evidence(seal(s), ['skiff']))).not.toContain('f-scope')
    add(s, 'telescope', service('Telescope', 'square'))
    expect(canonicalIds(evidence(seal(s), ['skiff']))).toContain('f-scope')
  })

  it('a revised body without a fresh declaration is unknown scope; nothing inherits', () => {
    const s = park()
    s.canonicalModules!.modules = s.canonicalModules!.modules.filter(
      (m) => m.moduleId !== 'f-skiff',
    )
    s.directory.knowledge = s.directory.knowledge.filter((k) => k.id !== 'alias-f-skiff')
    add(s, 'f-skiff', fact('River Skiff closure', 'River Skiff reopens October 25.'), {
      revision: '2',
    })
    const result = evidence(seal(s), ['moonwheel'])
    expect(result.canonicalSources.find((b) => b.moduleId === 'f-skiff')?.revisionId).toBe(
      'r2-f-skiff',
    )
  })

  it('compiled authority from an earlier source cannot serve a changed declaration', () => {
    const before = park(),
      compiled = compileGuestQueryCanonicalSource(before)
    const after = park()
    const row = after.canonicalModules!.modules.find((m) => m.moduleId === 'f-tap')!
    row.payload = fact('Water refill', BODY.tap, subjects(['skiff']))
    seal(after)
    expect(after.version).not.toBe(before.version)
    expect(() => guestCanonicalEvidenceAuthority(compiled.prepared, after)).toThrow(
      'Current compiler-owned source authority required',
    )
    expect(() =>
      prepareGuestSubjectEvidence({
        source: after,
        compiled,
        keys: ['knowledge:alias-moonwheel'],
        mode: 'DETAILS',
      }),
    ).toThrow()
  })

  it('cache on and off produce identical evidence, including after an asOf-only rebind', () => {
    const cache = createGuestQueryCompileCache({ buildIdentity: () => 'test-build' })
    const s = park()
    const direct = evidence(s, ['moonwheel'])
    const viaCache = (source: GuestQuerySource) =>
      prepareGuestSubjectEvidence({
        source,
        compiled: cache.compile(source),
        keys: ['knowledge:alias-moonwheel'],
        mode: 'DETAILS',
      })
    const first = viaCache(s)
    const later = { ...structuredClone(s), asOf: '2026-10-21T06:00:00.000Z' }
    const second = viaCache(later)
    expect(first.prompt).toBe(direct.prompt)
    expect(second.summary.retainedSourceKeys).toEqual(direct.summary.retainedSourceKeys)
    expect(second.summary).toMatchObject({ asOf: later.asOf })
    expect(second.prompt.replaceAll(later.asOf, AS_OF)).toBe(direct.prompt)
  })
})

/**
 * Representative large venue: SERVICE subjects on public places, several declared facts per
 * subject, VENUE facts, cross-subject facts and optional unknown-scope facts, each with its exact
 * Knowledge alias. The question goes through the real name catalog and plan parser; the planner
 * reply is a fixed stub, so no model is called.
 */
function largeVenue(input: { total: number; unknownFacts?: number; declared?: boolean }) {
  const declared = input.declared ?? true
  const s = venue(
    Array.from({ length: 100 }, (_, i) => [`area-${i}`, `Area ${String(i).padStart(3, '0')}`]),
  )
  const subjectCount = Math.floor(input.total / 5)
  const name = (i: number) => `Attraction ${String(i).padStart(5, '0')}`
  for (let i = 0; i < subjectCount; i++) add(s, `svc-${i}`, service(name(i), `area-${i % 100}`))
  const venueFacts = [
    ['Saturday hours', 'Admission runs 10:00 to 20:00 on Saturdays.'],
    ['Lightning', 'During lightning, every outdoor attraction closes until staff reopen it.'],
    ['Lost children', 'Lost children are brought to Guest Help.'],
  ] as const
  venueFacts.forEach(([label, value], i) =>
    add(s, `venue-${i}`, fact(label, value, declared ? VENUE : undefined)),
  )
  add(
    s,
    'cross-0',
    fact(
      'Combined ride',
      `${name(0)} riders may board ${name(1)} free on the same day.`,
      declared ? subjects(['svc-0', 'svc-1']) : undefined,
    ),
  )
  add(
    s,
    'cross-1',
    fact(
      'Shared queue exception',
      `${name(2)} and ${name(0)} share one queue, except during evening shows.`,
      declared ? subjects(['svc-0', 'svc-2']) : undefined,
    ),
  )
  for (let i = 0; i < (input.unknownFacts ?? 0); i++)
    add(
      s,
      `unknown-${i}`,
      fact(`Unreviewed note ${i}`, 'A public fact whose applicability is unknown.'),
    )
  const details = [
    'opens at 10:00',
    'needs a $4 ticket',
    'has a 110 cm minimum height',
    'closes in heavy rain',
  ]
  for (let i = 0; s.canonicalModules!.modules.length < input.total; i++) {
    const subject = i % subjectCount
    add(
      s,
      `fact-${i}`,
      fact(
        `${name(subject)} detail ${Math.floor(i / subjectCount)}`,
        `${name(subject)} ${details[Math.floor(i / subjectCount) % details.length]}.`,
        declared ? subjects([`svc-${subject}`]) : undefined,
      ),
    )
  }
  expect(s.canonicalModules!.modules).toHaveLength(input.total)
  return seal(s)
}
async function ask(s: GuestQuerySource, subject: string) {
  const question = `When does ${subject} open and what does it cost?`
  const p = compileGuestQueryCanonicalSource(s).prepared
  const data = p.namedCatalogData(p.discoverNamedCandidates(question), question)
  const group = data.groups.find((g) => g.record?.name === subject)
  expect(data.status).toBe('READY')
  expect(group?.candidateCount).toBe(1)
  return prepareGuestQueryEvidence({
    source: s,
    question,
    interpret: async () => JSON.stringify({ status: 'EVIDENCE_SUBJECTS', refs: [group!.ref] }),
  })
}
function expectedFor(s: GuestQuerySource, subjectId: string) {
  // Independent oracle over the authored rows: the subject, its place, every fact whose authored
  // declaration lists it, every VENUE fact and every fact without a declaration.
  const modules = s.canonicalModules!.modules
  const subject = modules.find((m) => m.moduleId === subjectId)!
  const keep = modules.filter((m) => {
    if (m.moduleId === subjectId) return true
    if (m.payload.kind !== 'OPERATIONAL_FACT') return false
    const a = m.payload.applicability
    return !a || a.scope === 'VENUE' || a.subjectModuleIds.includes(subjectId)
  })
  const placeId = subject.payload.kind === 'SERVICE' ? subject.payload.placeId : null
  return [
    `place:${placeId}`,
    ...keep.map((m) => `knowledge:alias-${m.moduleId}`),
    ...keep.map((m) => `canonical:${m.revisionId}`),
  ].sort()
}

describe('large venues under unchanged bounds', () => {
  it('100 extra declared unrelated facts: evidence succeeds and keeps every required body', async () => {
    const s = park()
    for (let i = 0; i < 100; i++)
      add(
        s,
        `extra-${i}`,
        fact(`River Skiff note ${i}`, `River Skiff detail number ${i}.`, subjects(['skiff'])),
      )
    seal(s)
    const r = await ask(s, 'Moonwheel')
    expect(r.status).toBe('LOOKUP_READY')
    if (r.status !== 'LOOKUP_READY') return
    expect(r.lookup.summary).toMatchObject({
      declaredFactApplicability: { omittedFactCount: 102, omittedFactAliasCount: 102 },
    })
    expect(r.lookup.canonicalSources.map((b) => b.moduleId).sort()).toEqual(
      canonicalIds(evidence(park(), ['moonwheel'])),
    )
  })

  it('100 extra unknown-scope facts still refuse the whole-source bound', async () => {
    const s = park()
    for (let i = 0; i < 100; i++) add(s, `extra-${i}`, fact(`Unreviewed note ${i}`, `Detail ${i}.`))
    await expect(ask(seal(s), 'Moonwheel')).rejects.toThrow('Whole subject source bound')
  })

  it('exactly 10,000 declared records: exact required evidence within bounds', async () => {
    const s = largeVenue({ total: 10_000 })
    expect(s.directory.knowledge).toHaveLength(10_000)
    for (const [subjectId, subject] of [
      ['svc-0', 'Attraction 00000'],
      ['svc-1999', 'Attraction 01999'],
    ] as const) {
      const r = await ask(s, subject)
      expect(r.status).toBe('LOOKUP_READY')
      if (r.status !== 'LOOKUP_READY') return
      expect([...r.lookup.summary.retainedSourceKeys].sort()).toEqual(expectedFor(s, subjectId))
      expect(r.lookup.summary.retainedSourceKeys.length).toBeLessThanOrEqual(99)
      expect(r.lookup.prompt.length).toBeLessThanOrEqual(30_000)
      for (const id of ['venue-0', 'venue-1', 'venue-2'])
        expect(r.lookup.summary.retainedSourceKeys).toContain(`canonical:r1-${id}`)
    }
    const zero = await ask(s, 'Attraction 00000')
    if (zero.status !== 'LOOKUP_READY') throw Error('expected evidence')
    expect(zero.lookup.summary.retainedSourceKeys).toEqual(
      expect.arrayContaining(['canonical:r1-cross-0', 'canonical:r1-cross-1']),
    )
  }, 120_000)

  it('exactly 10,000 records with 20 unknown-scope facts retains all 20 whole', async () => {
    const s = largeVenue({ total: 10_000, unknownFacts: 20 })
    const r = await ask(s, 'Attraction 00007')
    if (r.status !== 'LOOKUP_READY') throw Error('expected evidence')
    expect([...r.lookup.summary.retainedSourceKeys].sort()).toEqual(expectedFor(s, 'svc-7'))
    for (let i = 0; i < 20; i++)
      expect(r.lookup.summary.retainedSourceKeys).toContain(`canonical:r1-unknown-${i}`)
  }, 120_000)

  it('exactly 10,000 records with too many unknown or no declarations refuses truthfully', async () => {
    await expect(
      ask(largeVenue({ total: 10_000, unknownFacts: 60 }), 'Attraction 00007'),
    ).rejects.toThrow('Whole subject source bound')
    await expect(
      ask(largeVenue({ total: 10_000, declared: false }), 'Attraction 00007'),
    ).rejects.toThrow('Whole subject source bound')
  }, 240_000)
})
