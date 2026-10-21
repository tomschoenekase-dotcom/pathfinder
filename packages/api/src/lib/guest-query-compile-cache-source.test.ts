import { describe, expect, it, vi } from 'vitest'
import { createGuestQueryCompileCache } from './guest-query-compile-cache'
import {
  compileGuestQueryCanonicalSource,
  guestCanonicalEvidenceAuthority,
} from './guest-query-canonical-projection'
import {
  loadGuestQuerySource,
  type GuestQuerySource,
  type GuestQueryTransactionClient,
} from './guest-query-source'

const TENANT = 'cache-source-tenant'
const VENUE = 'cache-source-venue'
const EARLY = new Date('2026-10-21T05:00:00.000Z')
const CROSSING = new Date('2026-10-21T05:01:00.000Z')
const LATE = new Date('2026-10-21T05:02:00.000Z')

type Revision = {
  id: string
  moduleId: string
  tenantId: string
  venueId: string
  kind: 'SERVICE' | 'OPERATIONAL_FACT' | 'EVENT'
  version: number
  audience: 'PUBLIC' | 'CLIENT'
  effectiveFrom: Date | null
  effectiveUntil: Date | null
  evidence: []
  item: null
  policy: null
  relationship: null
  service: { name: string; description: string; availability: string; placeId: string } | null
  operationalFact: { label: string; value: string; expiresAt: Date | null } | null
  event: {
    name: string
    description: string
    startsAt: Date
    endsAt: Date | null
    placeId: string
  } | null
}
function service(id = 'service-a'): Revision {
  return {
    id: `revision-${id}`,
    moduleId: id,
    tenantId: TENANT,
    venueId: VENUE,
    kind: 'SERVICE',
    version: 1,
    audience: 'PUBLIC',
    effectiveFrom: null,
    effectiveUntil: null,
    evidence: [],
    item: null,
    policy: null,
    relationship: null,
    operationalFact: null,
    event: null,
    service: {
      name: `Clock tour ${id}`,
      description: 'A complete tour description.',
      availability: 'Booking required.',
      placeId: 'place-a',
    },
  }
}
function place() {
  return {
    id: 'place-a',
    tenantId: TENANT,
    venueId: VENUE,
    isActive: true,
    visibility: 'PUBLIC',
    name: 'Clock Gallery',
    type: 'EXHIBIT',
    itemType: 'gallery',
    shortDescription: 'Historic clocks.',
    longDescription: 'Keep bags closed.',
    lat: null,
    lng: null,
    tags: [] as string[],
    areaName: 'North',
    hours: 'Daily',
    photoUrl: null,
    sourceType: 'MANUAL',
    sourceName: null,
    sourceUrl: null,
    updatedAt: new Date('2026-10-20T00:00:00.000Z'),
  }
}
function knowledge() {
  return {
    id: 'legacy-a',
    tenantId: TENANT,
    venueId: VENUE,
    isEnabled: true,
    visibility: 'PUBLIC',
    title: 'Admission',
    category: 'VISIT',
    content: 'Admission requires a ticket.',
    sourceType: 'MANUAL',
    sourceName: null,
    sourceUrl: null,
    updatedAt: new Date('2026-10-20T00:00:00.000Z'),
    lastReviewedAt: null,
    contentModuleId: null,
    contentRevisionId: null,
    contentPublicationId: null,
    contentRevision: null,
  }
}
type Page = {
  where: {
    tenantId: string
    venueId: string
    visibility?: string
    isActive?: boolean
    isEnabled?: boolean
    sourceType?: { not: string }
    id?: { gt: string }
  }
  select: Record<string, unknown>
  take: number
}
function scopedPage(rows: Array<{ id: string } & Record<string, unknown>>, args: Page) {
  expect(args.where).toMatchObject({ tenantId: TENANT, venueId: VENUE })
  // A small ORM boundary, not a mock of source admission: honor the scope requested by
  // the production directory loader. In particular, removing its visibility predicate
  // makes the visibility-miss test fail. Real resolver code owns all clock filtering.
  return rows
    .filter(
      (row) =>
        row.tenantId === args.where.tenantId &&
        row.venueId === args.where.venueId &&
        (args.where.visibility === undefined || row.visibility === args.where.visibility) &&
        (args.where.isActive === undefined || row.isActive === args.where.isActive) &&
        (args.where.isEnabled === undefined || row.isEnabled === args.where.isEnabled) &&
        (!args.where.sourceType || row.sourceType !== args.where.sourceType.not) &&
        (!args.where.id || row.id > args.where.id.gt),
    )
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, args.take)
    .map((row) =>
      Object.fromEntries(
        Object.keys(args.select)
          .filter((key) => key in row)
          .map((key) => [key, structuredClone(row[key])]),
      ),
    )
}
function database(initial = service()) {
  const state = {
    revisions: [initial],
    places: [place()],
    knowledge: [knowledge()],
    adopted: [] as string[],
    publications: [
      {
        id: 'publication-1',
        moduleId: initial.moduleId,
        revisionId: initial.id,
        action: 'PUBLISH',
        order: 1,
      },
    ],
  }
  const reader = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      expect(values).toEqual([TENANT, VENUE, 10_001])
      const query = sql.join('?')
      expect(query).toContain('SELECT DISTINCT ON (publication."module_id")')
      expect(query).toContain('publication."event_order" DESC')
      expect(query.slice(query.indexOf(') AS latest'))).toContain('WHERE latest."action"')
      // This fake boundary supplies current heads; SQL execution/concurrency belongs to
      // existing resolver integration coverage. No effective/expiry filtering occurs here.
      const latest = new Map<string, (typeof state.publications)[number]>()
      for (const row of state.publications)
        if (!latest.has(row.moduleId) || latest.get(row.moduleId)!.order < row.order)
          latest.set(row.moduleId, row)
      return [...latest.values()]
        .filter((row) => row.action === 'PUBLISH')
        .sort((a, b) => a.moduleId.localeCompare(b.moduleId))
        .map((row) => ({
          moduleId: row.moduleId,
          revisionId: row.revisionId,
          publicationId: row.id,
          publicationOrder: String(row.order),
        }))
    }),
    contentModuleRevision: {
      findMany: vi.fn(
        async (args: { where: { tenantId: string; venueId: string; id: { in: string[] } } }) => {
          expect(args.where).toMatchObject({ tenantId: TENANT, venueId: VENUE })
          // Return immutable rows including future/expired ones: the actual publication
          // resolver must filter them, rather than a fake adapter making the test pass.
          return structuredClone(state.revisions.filter((row) => args.where.id.in.includes(row.id)))
        },
      ),
    },
    place: { findMany: vi.fn(async (args: Page) => scopedPage(state.places, args)) },
    venueKnowledgeEntry: {
      findMany: vi.fn(async (args: Page) => scopedPage(state.knowledge, args)),
    },
    legacyKnowledgeAdoptionActivation: {
      findMany: vi.fn(async (args: { where: { tenantId: string; venueId: string } }) => {
        expect(args.where).toEqual({ tenantId: TENANT, venueId: VENUE })
        return state.adopted.map((id) => ({ adoption: { legacyKnowledgeEntryId: id } }))
      }),
    },
  }
  const transaction = vi.fn((options: { isolationLevel: 'RepeatableRead'; timeout: number }) => {
    expect(options).toEqual({ isolationLevel: 'RepeatableRead', timeout: 15_000 })
  })
  const client: GuestQueryTransactionClient = {
    $transaction: async <T>(
      read: (value: unknown) => Promise<T>,
      options: { isolationLevel: 'RepeatableRead'; timeout: number },
    ): Promise<T> => {
      transaction(options)
      return read(reader)
    },
  }
  return {
    state,
    reader,
    transaction,
    load: (asOf = EARLY) =>
      loadGuestQuerySource({
        client,
        scope: { tenantId: TENANT, venueId: VENUE, includeSecondLayer: false, asOf },
        readPath: 'LEGACY',
      }),
  }
}
const cache = () =>
  createGuestQueryCompileCache({ buildIdentity: () => 'resolver-freshness-test-build' })
async function warm(db: ReturnType<typeof database>, memo: ReturnType<typeof cache>, asOf = EARLY) {
  const first = await db.load(asOf)
  memo.compile(first)
  const unchanged = await db.load(asOf)
  expect(unchanged.version).toBe(first.version)
  memo.compile(unchanged)
  expect(memo.stats()).toMatchObject({ misses: 1, hits: 1 })
  return first
}
function expectFreshMiss(
  memo: ReturnType<typeof cache>,
  first: GuestQuerySource,
  next: GuestQuerySource,
) {
  expect(next.version).not.toBe(first.version)
  const before = memo.stats()
  memo.compile(next)
  expect(memo.stats()).toMatchObject({ misses: before.misses + 1, hits: before.hits })
  memo.compile(next)
  expect(memo.stats().hits).toBe(before.hits + 1)
}

describe('compile cache uses newly resolved admitted source membership', () => {
  it('misses after a newly published module is loaded through a fresh RR snapshot', async () => {
    const db = database(),
      memo = cache(),
      first = await warm(db, memo)
    const extra = service('service-b')
    db.state.revisions.push(extra)
    db.state.publications.push({
      id: 'publication-2',
      moduleId: extra.moduleId,
      revisionId: extra.id,
      action: 'PUBLISH',
      order: 2,
    })
    const next = await db.load()
    expect(next.canonicalModules!.modules.map((row) => row.moduleId)).toEqual([
      'service-a',
      'service-b',
    ])
    expectFreshMiss(memo, first, next)
    expect(db.transaction).toHaveBeenCalledTimes(3)
  })
  it('misses after the current publication is withdrawn, without reviving its predecessor', async () => {
    const db = database(),
      memo = cache(),
      first = await warm(db, memo)
    db.state.publications.push({
      ...db.state.publications[0]!,
      id: 'withdrawal-2',
      action: 'WITHDRAW',
      order: 2,
    })
    const next = await db.load()
    expect(next.canonicalModules!.modules).toEqual([])
    expectFreshMiss(memo, first, next)
  })
  it.each(['place', 'knowledge'] as const)(
    'misses a fresh %s body edit even without an updatedAt change',
    async (kind) => {
      const db = database(),
        memo = cache(),
        first = await warm(db, memo)
      if (kind === 'place') db.state.places[0]!.longDescription = 'Bags must stay in lockers.'
      else db.state.knowledge[0]!.content = 'Admission is free today.'
      const next = await db.load()
      expectFreshMiss(memo, first, next)
    },
  )
  it('misses when a place becomes private under the actual public-directory scope', async () => {
    const db = database(),
      memo = cache(),
      first = await warm(db, memo)
    db.state.places[0]!.visibility = 'PRIVATE'
    const next = await db.load()
    expect(next.directory.places).toEqual([])
    expectFreshMiss(memo, first, next)
  })
  it('misses when legacy adoption activation removes an unbound compatibility row', async () => {
    const db = database(),
      memo = cache(),
      first = await warm(db, memo)
    db.state.adopted.push('legacy-a')
    const next = await db.load()
    expect(first.directory.knowledge.map((row) => row.id)).toEqual(['legacy-a'])
    expect(next.directory.knowledge).toEqual([])
    expectFreshMiss(memo, first, next)
  })
  it('misses at effectiveFrom using real resolver filtering and unchanged stored rows', async () => {
    const revision = service()
    revision.effectiveFrom = CROSSING
    const db = database(revision),
      memo = cache(),
      first = await warm(db, memo)
    expect(first.canonicalModules!.modules).toEqual([])
    const next = await db.load(CROSSING)
    expect(next.canonicalModules!.modules.map((row) => row.moduleId)).toEqual(['service-a'])
    expectFreshMiss(memo, first, next)
    expect(db.reader.contentModuleRevision.findMany).toHaveBeenCalledTimes(3)
  })
  it('misses exactly at effectiveUntil using real resolver filtering and unchanged stored rows', async () => {
    const revision = service()
    revision.effectiveUntil = CROSSING
    const db = database(revision),
      memo = cache(),
      first = await warm(db, memo)
    expect(first.canonicalModules!.modules).toHaveLength(1)
    const next = await db.load(CROSSING)
    expect(next.canonicalModules!.modules).toEqual([])
    expectFreshMiss(memo, first, next)
  })
  it('misses at an operational fact expiry without requiring a publication event', async () => {
    const revision: Revision = {
      ...service('fact-a'),
      kind: 'OPERATIONAL_FACT',
      service: null,
      operationalFact: {
        label: 'Queue note',
        value: 'Use the east entrance.',
        expiresAt: CROSSING,
      },
    }
    const db = database(revision),
      memo = cache(),
      first = await warm(db, memo)
    expect(first.canonicalModules!.modules).toHaveLength(1)
    const next = await db.load(CROSSING)
    expect(next.canonicalModules!.modules).toEqual([])
    expectFreshMiss(memo, first, next)
  })
})

function omitObservationTime(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(omitObservationTime)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'asOf')
        .map(([key, child]) => [key, omitObservationTime(child)]),
    )
  return value
}
function observableCompile(source: GuestQuerySource) {
  const { prepared, productMetadataProof, ...fields } = compileGuestQueryCanonicalSource(source)
  void productMetadataProof
  const question = 'Tell me about Clock Gallery'
  const catalog = prepared.discoverNamedCandidates(question)
  return {
    ...fields,
    prepared: {
      scope: prepared.scope,
      sourceVersion: prepared.sourceVersion,
      asOf: prepared.asOf,
      coverage: prepared.coverage,
      snapshotIdentity: prepared.snapshotIdentity,
      vocabulary: prepared.planningVocabulary(),
      names: prepared.namedCatalogData(catalog, question),
      result: prepared
        .evaluate({ ...prepared.scope, mode: 'list', domain: 'ALL', predicates: [] })
        .page(),
    },
    authority: guestCanonicalEvidenceAuthority(prepared, source),
  }
}

it('compiler observation-time invariant: identical admitted rows at two clocks differ only in asOf', async () => {
  const revision = service()
  revision.effectiveFrom = EARLY
  revision.effectiveUntil = new Date('2026-10-21T06:00:00.000Z')
  const db = database(revision)
  const event: Revision = {
    ...service('event-a'),
    kind: 'EVENT',
    service: null,
    event: {
      name: 'Clock demonstration',
      description: 'A public demonstration.',
      startsAt: CROSSING,
      endsAt: null,
      placeId: 'place-a',
    },
  }
  const fact: Revision = {
    ...service('fact-a'),
    kind: 'OPERATIONAL_FACT',
    service: null,
    operationalFact: {
      label: 'Entry note',
      value: 'Use the east entrance.',
      expiresAt: new Date('2026-10-21T06:00:00.000Z'),
    },
  }
  for (const [index, row] of [event, fact].entries()) {
    db.state.revisions.push(row)
    db.state.publications.push({
      id: `publication-${index + 2}`,
      moduleId: row.moduleId,
      revisionId: row.id,
      action: 'PUBLISH',
      order: index + 2,
    })
  }
  const first = await db.load(EARLY),
    second = await db.load(LATE)
  expect(first.asOf).not.toBe(second.asOf)
  expect(first.version).toBe(second.version)
  expect(omitObservationTime(first)).toEqual(omitObservationTime(second))
  const firstCompiled = observableCompile(first),
    secondCompiled = observableCompile(second)
  expect(firstCompiled.prepared.asOf).toBe(first.asOf)
  expect(secondCompiled.prepared.asOf).toBe(second.asOf)
  // The event start crosses the two clocks while admitted membership does not. Any new
  // compiler-only clock-relative interpretation must change this assertion and block reuse.
  expect(omitObservationTime(firstCompiled)).toEqual(omitObservationTime(secondCompiled))
  const memo = cache()
  memo.compile(first)
  const rebound = memo.compile(second)
  expect(memo.stats()).toMatchObject({ misses: 1, hits: 1 })
  expect(rebound.prepared.asOf).toBe(second.asOf)
  expect(guestCanonicalEvidenceAuthority(rebound.prepared, second)).toEqual(
    guestCanonicalEvidenceAuthority(compileGuestQueryCanonicalSource(second).prepared, second),
  )
})
