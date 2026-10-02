/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory Prisma fakes are loosely typed on purpose */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Knowledge = {
  id: string
  tenantId: string
  venueId: string
  title: string
  category: string
  content: string
  isEnabled: boolean
  visibility: string
  updatedAt: Date
  contentModuleId: string | null
}
type PlaceRow = {
  id: string
  tenantId: string
  venueId: string
  name: string
  shortDescription: string | null
  longDescription: string | null
  hours: string | null
  areaName: string | null
  isActive: boolean
  visibility: string
  updatedAt: Date
}
type Revision = {
  id: string
  version: number
  audience: 'PUBLIC' | 'CLIENT' | 'OPERATOR'
  effectiveFrom: Date | null
  effectiveUntil: Date | null
  createdAt: Date
  service?: Record<string, unknown> | null
  policy?: Record<string, unknown> | null
  evidence?: unknown[]
}
type Module = { id: string; tenantId: string; venueId: string; kind: string; revisions: Revision[] }

const store = vi.hoisted(() => ({
  knowledge: new Map<string, unknown>(),
  places: new Map<string, unknown>(),
  modules: new Map<string, unknown>(),
  publications: [] as Array<{
    id: string
    moduleId: string
    revisionId: string
    action: string
    eventOrder: number
  }>,
  sourceInputs: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ action: string; input: Record<string, any> }>,
  clock: 0,
}))

vi.mock('@pathfinder/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/db')>()
  const tick = () => new Date(Date.UTC(2026, 9, 2, 12, 0, 0, ++store.clock))
  const conflict = (message: string) => new actual.LegacyContentActionError('CONFLICT', message)
  const run = <T>(
    client: { $transaction: (fn: () => Promise<T>) => Promise<T> },
    fn: () => Promise<T>,
  ) => client.$transaction(fn)
  const legacyUpdate = (map: Map<string, any>, action: string) => async (input: any, client: any) =>
    run(client, async () => {
      store.calls.push({ action, input })
      const row = map.get(input.id)
      if (!row || row.tenantId !== input.tenantId || row.venueId !== input.venueId) {
        throw new actual.LegacyContentActionError('NOT_FOUND', 'not found')
      }
      if (row.updatedAt.getTime() !== input.expectedUpdatedAt.getTime() || row.contentModuleId) {
        throw conflict('Content changed after this page loaded')
      }
      const next = { ...row, ...input.fields, updatedAt: tick() }
      map.set(input.id, next)
      return next
    })
  const universalConflict = (message: string) =>
    new actual.UniversalContentActionError('CONFLICT', message)
  return {
    ...actual,
    createLegacyKnowledgeAction: vi.fn(async (input: any, client: any) =>
      run(client, async () => {
        store.calls.push({ action: 'createKnowledge', input })
        const row = {
          id: `k_new_${store.knowledge.size}`,
          tenantId: input.tenantId,
          venueId: input.venueId,
          visibility: 'PUBLIC',
          contentModuleId: null,
          updatedAt: tick(),
          ...input.fields,
        }
        store.knowledge.set(row.id, row)
        return row
      }),
    ),
    updateLegacyKnowledgeAction: vi.fn(legacyUpdate(store.knowledge, 'updateKnowledge')),
    retireLegacyKnowledgeAction: vi.fn(async (input: any, client: any) =>
      legacyUpdate(store.knowledge, 'retireKnowledge')(
        { ...input, fields: { isEnabled: false } },
        client,
      ),
    ),
    updateLegacyPlaceAction: vi.fn(legacyUpdate(store.places, 'updatePlace')),
    retireLegacyPlaceAction: vi.fn(async (input: any, client: any) =>
      legacyUpdate(store.places, 'retirePlace')({ ...input, fields: { isActive: false } }, client),
    ),
    createUniversalContentAction: vi.fn(async (input: any) =>
      run(input.db, async () => {
        store.calls.push({ action: 'createTyped', input })
        const revision: Revision = {
          id: `rev_${input.moduleId}_1`,
          version: 1,
          audience: input.draft.audience,
          effectiveFrom: null,
          effectiveUntil: null,
          createdAt: tick(),
        }
        store.modules.set(input.moduleId, {
          id: input.moduleId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          kind: input.draft.payload.kind,
          revisions: [revision],
        })
        return {
          moduleId: input.moduleId,
          revisionId: revision.id,
          kind: input.draft.payload.kind,
          version: 1,
        }
      }),
    ),
    addUniversalContentRevisionAction: vi.fn(async (input: any) =>
      run(input.db, async () => {
        store.calls.push({ action: 'updateTyped', input })
        const module = store.modules.get(input.moduleId) as Module
        const latest = module.revisions[0]!
        if (latest.version !== input.expectedLatestVersion)
          throw universalConflict('Latest version moved')
        const revision: Revision = {
          id: `rev_${input.moduleId}_${latest.version + 1}`,
          version: latest.version + 1,
          audience: input.draft.audience,
          effectiveFrom: null,
          effectiveUntil: null,
          createdAt: tick(),
          [input.draft.payload.kind.toLowerCase()]: input.draft.payload,
        }
        module.revisions.unshift(revision)
        return {
          moduleId: input.moduleId,
          revisionId: revision.id,
          kind: module.kind,
          version: revision.version,
        }
      }),
    ),
    retireUniversalContentAction: vi.fn(async (input: any) =>
      run(input.db, async () => {
        store.calls.push({ action: 'retireTyped', input })
        const module = store.modules.get(input.moduleId) as Module
        const latest = module.revisions[0]!
        if (latest.version !== input.expectedLatestVersion)
          throw universalConflict('Latest version moved')
        const revision: Revision = {
          ...latest,
          id: `rev_${input.moduleId}_${latest.version + 1}`,
          version: latest.version + 1,
          effectiveUntil: new Date(input.effectiveUntil),
          createdAt: tick(),
        }
        module.revisions.unshift(revision)
        return {
          moduleId: input.moduleId,
          revisionId: revision.id,
          kind: module.kind,
          version: revision.version,
        }
      }),
    ),
    withdrawUniversalContentAction: vi.fn(async (input: any) =>
      run(input.db, async () => {
        store.calls.push({ action: 'withdrawTyped', input })
        store.publications.push({
          id: `pub_${store.publications.length + 1}`,
          moduleId: input.moduleId,
          revisionId: input.expectedPublishedRevisionId,
          action: 'WITHDRAW',
          eventOrder: store.publications.length + 1,
        })
        return {
          publicationId: 'pub',
          moduleId: input.moduleId,
          revisionId: 'r',
          action: 'WITHDRAW',
          replayed: false,
        }
      }),
    ),
  }
})

import { OPERATOR_READ_TOOLS } from './tools'
import {
  applyChangeset,
  changesetProblems,
  describeChangeset,
  expectedChangesetVersion,
  pendingChangesetChanges,
  resolveChangeset,
  type ChangesetScope,
} from './content-changeset'
import { OperatorStaleError, type OperatorApplyContext } from './proposals'
import type { OperatorCallContext } from './registry'
import { venuesContentChangesetKind } from './kinds/venues-content-changeset'

const TENANT = 'tenant_a'
const VENUE = 'venue_a'
const NOW = new Date('2026-10-02T12:00:00.000Z')
const OPERATION = '3f2b8a52-6c1e-4f5e-9d8a-1b2c3d4e5f60'
const T0 = new Date('2026-09-01T10:00:00.000Z')

function seed() {
  store.knowledge.clear()
  store.places.clear()
  store.modules.clear()
  store.publications.length = 0
  store.sourceInputs.length = 0
  store.calls.length = 0
  const knowledge = (row: Partial<Knowledge> & { id: string; title: string; content: string }) =>
    store.knowledge.set(row.id, {
      tenantId: TENANT,
      venueId: VENUE,
      category: 'General',
      isEnabled: true,
      visibility: 'PUBLIC',
      updatedAt: T0,
      contentModuleId: null,
      ...row,
    })
  knowledge({ id: 'k_hours', title: 'Opening hours', content: 'Open daily 9 to 5.' })
  knowledge({ id: 'k_tickets', title: 'Tickets', content: 'Tickets cost 10 dollars.' })
  knowledge({
    id: 'k_staff',
    title: 'Staff room code',
    content: 'Door code 1234.',
    visibility: 'SECOND_LAYER',
  })
  knowledge({
    id: 'k_projected',
    title: 'Projected fact',
    content: 'From a typed module.',
    contentModuleId: 'm_fact',
  })
  const place = (row: Partial<PlaceRow> & { id: string; name: string }) =>
    store.places.set(row.id, {
      tenantId: TENANT,
      venueId: VENUE,
      shortDescription: null,
      longDescription: null,
      hours: '9-5',
      areaName: null,
      isActive: true,
      visibility: 'PUBLIC',
      updatedAt: T0,
      ...row,
    })
  place({ id: 'p_lions', name: 'Lion House', hours: '9-5' })
  place({ id: 'p_office', name: 'Back office', visibility: 'SECOND_LAYER' })
  store.modules.set('m_tours', {
    id: 'm_tours',
    tenantId: TENANT,
    venueId: VENUE,
    kind: 'SERVICE',
    revisions: [
      {
        id: 'rev_tours_1',
        version: 1,
        audience: 'PUBLIC',
        effectiveFrom: null,
        effectiveUntil: null,
        createdAt: T0,
        service: {
          name: 'Boat tours',
          description: 'Daily 10 to 4',
          availability: null,
          placeId: null,
        },
        evidence: [],
      },
    ],
  } satisfies Module)
  store.modules.set('m_internal', {
    id: 'm_internal',
    tenantId: TENANT,
    venueId: VENUE,
    kind: 'POLICY',
    revisions: [
      {
        id: 'rev_internal_1',
        version: 3,
        audience: 'OPERATOR',
        effectiveFrom: null,
        effectiveUntil: null,
        createdAt: T0,
        policy: { title: 'Refund rule', rule: 'Managers may refund up to 50.', appliesTo: [] },
      },
    ],
  } satisfies Module)
  store.publications.push({
    id: 'pub_1',
    moduleId: 'm_tours',
    revisionId: 'rev_tours_1',
    action: 'PUBLISH',
    eventOrder: 1,
  })
  store.sourceInputs.push({
    tenantId: TENANT,
    venueId: VENUE,
    sourceId: 'src_1',
    ordinal: 0,
    retrievedAt: new Date('2026-09-30T08:00:00.000Z'),
    contentHash: 'a'.repeat(64),
    disposition: 'SUCCEEDED',
  })
  store.clock = 0
}

function scoped<T extends { tenantId: string; venueId?: string }>(
  rows: Iterable<unknown>,
  where: any,
) {
  return [...rows].filter((row) => {
    const value = row as T & Record<string, unknown>
    if (where.tenantId !== undefined && value.tenantId !== where.tenantId) return false
    if (where.venueId !== undefined && value.venueId !== where.venueId) return false
    if (where.id !== undefined && typeof where.id === 'string' && value.id !== where.id)
      return false
    if (where.id?.in && !where.id.in.includes(value.id)) return false
    if (where.isEnabled !== undefined && value.isEnabled !== where.isEnabled) return false
    if (where.isActive !== undefined && value.isActive !== where.isActive) return false
    if (
      where.visibility &&
      typeof where.visibility === 'string' &&
      value.visibility !== where.visibility
    )
      return false
    if (where.NOT?.visibility && value.visibility === where.NOT.visibility) return false
    if (
      where.title?.equals &&
      String(value.title).toLowerCase() !== where.title.equals.toLowerCase()
    )
      return false
    return true
  })
}

const database = {
  tenant: { findUnique: async () => ({ id: TENANT }) },
  venue: {
    findFirst: async ({ where }: any) =>
      where.id === VENUE && where.tenantId === TENANT
        ? { id: VENUE, slug: 'venue-a', isActive: true }
        : null,
  },
  venueKnowledgeEntry: {
    findFirst: async ({ where }: any) => scoped(store.knowledge.values(), where)[0] ?? null,
    findMany: async ({ where, take }: any) =>
      scoped(store.knowledge.values(), where).slice(0, take ?? 100),
    count: async ({ where }: any) => scoped(store.knowledge.values(), where).length,
  },
  place: {
    findFirst: async ({ where }: any) => scoped(store.places.values(), where)[0] ?? null,
    findMany: async ({ where, take }: any) =>
      scoped(store.places.values(), where).slice(0, take ?? 100),
    count: async ({ where }: any) => scoped(store.places.values(), where).length,
  },
  serviceContent: { count: async () => 0 },
  itemContent: { count: async () => 0 },
  eventContent: { count: async () => 0 },
  contentModuleIdentity: {
    findFirst: async ({ where, select }: any) => {
      const module = scoped(store.modules.values(), where)[0] as Module | undefined
      if (!module) return null
      const take = select?.revisions?.take ?? 1
      return { ...module, revisions: module.revisions.slice(0, take) }
    },
    findMany: async ({ where, take }: any) =>
      (scoped(store.modules.values(), where) as Module[])
        .slice(0, take)
        .map((module) => ({ ...module, revisions: module.revisions.slice(0, 1) })),
    count: async ({ where }: any) => {
      const base = scoped(store.modules.values(), where) as Module[]
      return where.id?.in
        ? base.length
        : base.filter((m) => m.revisions.some((r) => r.audience !== 'PUBLIC')).length
    },
  },
  contentModuleRevision: {
    findMany: async ({ where }: any) =>
      (
        scoped(store.modules.values(), {
          tenantId: where.tenantId,
          venueId: where.venueId,
        }) as Module[]
      )
        .flatMap((module) => module.revisions)
        .filter((revision) => where.id.in.includes(revision.id)),
  },
  contentModulePublication: {
    findMany: async ({ where }: any) => {
      const latest = new Map<string, (typeof store.publications)[number]>()
      for (const event of [...store.publications].sort((a, b) => b.eventOrder - a.eventOrder)) {
        if (where.moduleId.in.includes(event.moduleId) && !latest.has(event.moduleId)) {
          latest.set(event.moduleId, event)
        }
      }
      return [...latest.values()]
    },
  },
  venueSourceInput: {
    findFirst: async ({ where }: any) =>
      store.sourceInputs.find(
        (row) =>
          row.tenantId === where.tenantId &&
          row.venueId === where.venueId &&
          row.sourceId === where.sourceId &&
          row.ordinal === where.ordinal,
      ) ?? null,
  },
  // Rolls the in-memory store back when the callback throws, like a real transaction.
  $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
    const snapshot = {
      knowledge: new Map(store.knowledge),
      places: new Map(store.places),
      modules: new Map([...store.modules].map(([id, m]) => [id, structuredClone(m)])),
      publications: [...store.publications],
    }
    try {
      return await run(database)
    } catch (error) {
      store.knowledge = snapshot.knowledge as never
      store.places = snapshot.places as never
      store.modules = snapshot.modules as never
      store.publications.splice(0, store.publications.length, ...snapshot.publications)
      throw error
    }
  },
} as never

const grant = {
  grantId: 'grant_1',
  clientId: 'client_1',
  userId: 'user_1',
  allTenants: true,
  tenantIds: [],
  capabilities: ['venues:read', 'venues:propose'],
} as never

const applyContext = (): OperatorApplyContext => ({
  database,
  grant,
  now: NOW,
  actor: { type: 'HUMAN', id: 'human_1', role: 'PLATFORM_ADMIN' },
  proposalId: 'proposal_1',
  operationId: OPERATION,
})

const scope = (ops: ChangesetScope['ops']): ChangesetScope => ({
  tenantId: TENANT,
  venueId: VENUE,
  ops,
})
const iso = (value: Date) => value.toISOString()
const knowledgeRows = () => [...store.knowledge.values()] as Knowledge[]
const enabledTitled = (title: string) =>
  knowledgeRows().filter((row) => row.isEnabled && row.title.toLowerCase() === title.toLowerCase())

describe('content changeset: corrections retire the row they correct', () => {
  beforeEach(() => {
    vi.stubEnv('GENERALIZED_CONTENT_CAPABILITIES_ENABLED', 'true')
    seed()
  })

  it('updates the one row instead of appending a contradicting entry', async () => {
    const before = knowledgeRows().length
    const args = scope([
      {
        op: 'update',
        representation: 'LEGACY_KNOWLEDGE',
        id: 'k_hours',
        expectedRevision: iso(T0),
        body: 'Open daily 10 to 6 from October.',
      },
    ])
    const outcome = await applyChangeset(args, applyContext())
    expect(knowledgeRows()).toHaveLength(before)
    expect(enabledTitled('Opening hours')).toHaveLength(1)
    expect(enabledTitled('Opening hours')[0]!.content).toBe('Open daily 10 to 6 from October.')
    expect(outcome.result).toMatchObject({ published: false })
  })

  it('refuses a new entry that would contradict an enabled one, unless the same changeset retires it', async () => {
    const duplicate = scope([
      {
        op: 'create',
        representation: 'LEGACY_KNOWLEDGE',
        title: 'opening hours',
        body: 'Open 10 to 6.',
      },
    ])
    const refused = await resolveChangeset(database, duplicate, NOW)
    expect(changesetProblems(refused)[0]).toContain('contradicting entry')
    await expect(applyChangeset(duplicate, applyContext())).rejects.toMatchObject({
      code: 'CHANGESET_INVALID',
    })
    expect(store.calls).toHaveLength(0)

    const correction = scope([
      {
        op: 'retire',
        representation: 'LEGACY_KNOWLEDGE',
        id: 'k_hours',
        expectedRevision: iso(T0),
      },
      {
        op: 'create',
        representation: 'LEGACY_KNOWLEDGE',
        title: 'Opening hours',
        body: 'Open 10 to 6.',
      },
    ])
    await applyChangeset(correction, applyContext())
    // Exactly one enabled row carries the title; the obsolete one is retired, not deleted.
    expect(enabledTitled('Opening hours')).toHaveLength(1)
    expect(enabledTitled('Opening hours')[0]!.content).toBe('Open 10 to 6.')
    expect((store.knowledge.get('k_hours') as Knowledge).isEnabled).toBe(false)
    expect(store.knowledge.has('k_hours')).toBe(true)
  })

  it('leaves every row it does not name exactly as it was', async () => {
    const untouched = ['k_tickets', 'k_staff', 'k_projected', 'p_lions', 'p_office']
    const snapshot = untouched.map((id) =>
      structuredClone(store.knowledge.get(id) ?? store.places.get(id)),
    )
    await applyChangeset(
      scope([
        {
          op: 'update',
          representation: 'LEGACY_KNOWLEDGE',
          id: 'k_hours',
          expectedRevision: iso(T0),
          body: 'New hours.',
        },
        { op: 'retire', representation: 'LEGACY_PLACE', id: 'p_lions', expectedRevision: iso(T0) },
      ]),
      applyContext(),
    )
    const after = untouched.map((id) => store.knowledge.get(id) ?? store.places.get(id))
    expect(after[0]).toEqual(snapshot[0])
    expect(after[1]).toEqual(snapshot[1])
    expect(after[2]).toEqual(snapshot[2])
    expect(after[4]).toEqual(snapshot[4])
    // The retired place is hidden from guests, not deleted.
    expect((store.places.get('p_lions') as PlaceRow).isActive).toBe(false)
  })

  it('computes the diff, stale flag and version from live state', async () => {
    const args = scope([
      {
        op: 'update',
        representation: 'LEGACY_KNOWLEDGE',
        id: 'k_hours',
        expectedRevision: iso(T0),
        title: 'Hours',
        body: 'Open daily 10 to 6.',
      },
    ])
    const resolved = await resolveChangeset(database, args, NOW)
    expect(resolved.ops[0]!.changes).toEqual([
      { field: 'body', before: 'Open daily 9 to 5.', after: 'Open daily 10 to 6.' },
      { field: 'title', before: 'Opening hours', after: 'Hours' },
    ])
    expect(resolved.ops[0]!.stale).toBe(false)
    expect(resolved.currentVersion).toBe(resolved.expectedVersion)
    const lines = await pendingChangesetChanges(database, args, NOW)
    expect(lines.map((line) => line.field)).toEqual([
      '1. update k_hours · body',
      '1. update k_hours · title',
    ])
    expect(describeChangeset(args.ops)[0]).toContain('UPDATE LEGACY_KNOWLEDGE k_hours')
  })
})

describe('content changeset: stale-write rejection', () => {
  beforeEach(() => {
    vi.stubEnv('GENERALIZED_CONTENT_CAPABILITIES_ENABLED', 'true')
    seed()
  })

  const stale = scope([
    {
      op: 'update',
      representation: 'LEGACY_KNOWLEDGE',
      id: 'k_hours',
      expectedRevision: '2026-08-01T00:00:00.000Z',
      body: 'Stale correction.',
    },
  ])

  it('refuses at proposal time and creates nothing', async () => {
    await expect(
      venuesContentChangesetKind.authorize!(stale as never, { database, grant, now: NOW }),
    ).rejects.toBeInstanceOf(OperatorStaleError)
    const resolved = await resolveChangeset(database, stale, NOW)
    expect(resolved.ops[0]!.stale).toBe(true)
    expect(resolved.expectedVersion).not.toBe(resolved.currentVersion)
    expect(changesetProblems(resolved)[0]).toContain('Stale')
  })

  it('refuses at execution when the row moved after the proposal, with no write', async () => {
    const args = scope([
      {
        op: 'update',
        representation: 'LEGACY_KNOWLEDGE',
        id: 'k_hours',
        expectedRevision: iso(T0),
        body: 'Mine.',
      },
    ])
    const expected = await venuesContentChangesetKind.targetVersion(args as never, {
      database,
      grant,
      now: NOW,
    })
    // Someone else edits the row after the proposal was created.
    store.knowledge.set('k_hours', {
      ...(store.knowledge.get('k_hours') as Knowledge),
      content: 'Theirs.',
      updatedAt: new Date('2026-09-15T00:00:00Z'),
    })
    const current = await venuesContentChangesetKind.currentVersion(args as never, {
      database,
      grant,
      now: NOW,
    })
    expect(current).not.toBe(expected)
    await expect(applyChangeset(args, applyContext())).rejects.toBeInstanceOf(OperatorStaleError)
    expect((store.knowledge.get('k_hours') as Knowledge).content).toBe('Theirs.')
    expect(store.calls).toHaveLength(0)
  })

  it('rolls the whole changeset back when a later operation loses its race', async () => {
    const args = scope([
      {
        op: 'update',
        representation: 'LEGACY_KNOWLEDGE',
        id: 'k_hours',
        expectedRevision: iso(T0),
        body: 'First.',
      },
      {
        op: 'update',
        representation: 'LEGACY_KNOWLEDGE',
        id: 'k_tickets',
        expectedRevision: iso(T0),
        body: 'Second.',
      },
    ])
    // The row is edited between the pre-check and the canonical action's own locked re-check.
    const fake = database as any
    const real = fake.venueKnowledgeEntry.findFirst
    let reads = 0
    fake.venueKnowledgeEntry.findFirst = async (query: any) => {
      const row = await real(query)
      if (query.where.id === 'k_tickets' && ++reads === 1) {
        store.knowledge.set('k_tickets', {
          ...(row as Knowledge),
          updatedAt: new Date('2026-09-20T00:00:00Z'),
        })
      }
      return row
    }
    try {
      await expect(applyChangeset(args, applyContext())).rejects.toBeInstanceOf(OperatorStaleError)
    } finally {
      fake.venueKnowledgeEntry.findFirst = real
    }
    expect((store.knowledge.get('k_hours') as Knowledge).content).toBe('Open daily 9 to 5.')
  })

  it('refuses a duplicate target and bounds the operation count at the contract', async () => {
    const { OPERATOR_MCP_INPUTS } = await import('@pathfinder/contracts/operator-mcp')
    const schema = OPERATOR_MCP_INPUTS['venues.propose_content_changeset']
    const op = {
      op: 'retire',
      representation: 'LEGACY_KNOWLEDGE',
      id: 'k_hours',
      expectedRevision: iso(T0),
    }
    const base = { tenantId: TENANT, venueId: VENUE, operationId: OPERATION }
    expect(schema.safeParse({ ...base, ops: [op, op] }).success).toBe(false)
    expect(schema.safeParse({ ...base, ops: [] }).success).toBe(false)
    expect(schema.safeParse({ ...base, ops: [op] }).success).toBe(true)
    expect(
      schema.safeParse({
        ...base,
        ops: [
          {
            op: 'update',
            representation: 'LEGACY_KNOWLEDGE',
            id: 'k_hours',
            expectedRevision: iso(T0),
          },
        ],
      }).success,
    ).toBe(false)
    // A visibility change is not even expressible.
    expect(
      schema.safeParse({
        ...base,
        ops: [{ ...op, op: 'update', body: 'x', visibility: 'PUBLIC' }],
      }).success,
    ).toBe(false)
  })
})

describe('content changeset: audiences', () => {
  beforeEach(() => {
    vi.stubEnv('GENERALIZED_CONTENT_CAPABILITIES_ENABLED', 'true')
    seed()
  })

  it('never changes the audience of a second-layer row it corrects', async () => {
    const resolved = await resolveChangeset(
      database,
      scope([
        {
          op: 'update',
          representation: 'LEGACY_KNOWLEDGE',
          id: 'k_staff',
          expectedRevision: iso(T0),
          body: 'Door code 9999.',
        },
      ]),
      NOW,
    )
    expect(resolved.ops[0]!.notes.join(' ')).toContain('employee-only')
    await applyChangeset(
      scope([
        {
          op: 'update',
          representation: 'LEGACY_KNOWLEDGE',
          id: 'k_staff',
          expectedRevision: iso(T0),
          body: 'Door code 9999.',
        },
      ]),
      applyContext(),
    )
    const [call] = store.calls
    expect(call!.input.fields).toEqual({ content: 'Door code 9999.' })
    expect(call!.input.fields).not.toHaveProperty('visibility')
    expect((store.knowledge.get('k_staff') as Knowledge).visibility).toBe('SECOND_LAYER')
  })

  it('refuses to correct a projected row (edit the typed module) and a retired row', async () => {
    const projected = await resolveChangeset(
      database,
      scope([
        {
          op: 'retire',
          representation: 'LEGACY_KNOWLEDGE',
          id: 'k_projected',
          expectedRevision: iso(T0),
        },
      ]),
      NOW,
    )
    expect(changesetProblems(projected)[0]).toContain('projected from typed module m_fact')
    store.knowledge.set('k_hours', {
      ...(store.knowledge.get('k_hours') as Knowledge),
      isEnabled: false,
    })
    const retired = await resolveChangeset(
      database,
      scope([
        {
          op: 'retire',
          representation: 'LEGACY_KNOWLEDGE',
          id: 'k_hours',
          expectedRevision: iso(T0),
        },
      ]),
      NOW,
    )
    expect(changesetProblems(retired)[0]).toContain('already retired')
  })

  it('does not let a correction widen a typed audience, and creates non-public typed drafts unpublished', async () => {
    const widen = await resolveChangeset(
      database,
      scope([
        {
          op: 'update',
          representation: 'TYPED_REVISION',
          id: 'm_internal',
          expectedRevision: '3',
          draft: {
            audience: 'PUBLIC',
            payload: {
              kind: 'POLICY',
              title: 'Refund rule',
              rule: 'Managers may refund up to 50.',
              appliesTo: [],
            },
          },
        },
      ]),
      NOW,
    )
    expect(changesetProblems(widen)[0]).toContain('audience cannot change')

    await applyChangeset(
      scope([
        {
          op: 'create',
          representation: 'TYPED_REVISION',
          draft: {
            audience: 'CLIENT',
            payload: {
              kind: 'OPERATIONAL_FACT',
              label: 'Pricing note',
              value: 'Client-only discount 20%.',
            },
          },
        },
      ]),
      applyContext(),
    )
    const created = store.calls.find((call) => call.action === 'createTyped')!
    expect(created.input.draft.audience).toBe('CLIENT')
    // Authoring is the only effect: nothing was published or withdrawn.
    expect(store.calls.map((call) => call.action)).toEqual(['createTyped'])
    expect(store.publications.filter((event) => event.action === 'PUBLISH')).toHaveLength(1)
  })

  it('shows guests nothing from a second-layer row or an operator-only module', async () => {
    const context = (extra: object = {}) =>
      ({ database, grant, now: NOW, ...extra }) as unknown as OperatorCallContext
    const list = OPERATOR_READ_TOOLS.find((tool) => tool.name === 'venues.list_content')!
    const knowledge = (await list.handler(
      { tenantId: TENANT, venueId: VENUE, representation: 'LEGACY_KNOWLEDGE' },
      context(),
    )) as {
      items: Array<{ id: string; audience: string; guestVisible: boolean; revision: string }>
    }
    const byId = new Map(knowledge.items.map((item) => [item.id, item]))
    expect(byId.get('k_hours')).toMatchObject({
      audience: 'PUBLIC',
      guestVisible: true,
      revision: iso(T0),
    })
    expect(byId.get('k_staff')).toMatchObject({ audience: 'SECOND_LAYER', guestVisible: false })

    const typed = (await list.handler(
      { tenantId: TENANT, venueId: VENUE, representation: 'TYPED_REVISION' },
      context(),
    )) as {
      items: Array<{
        id: string
        audience: string
        guestVisible: boolean
        publishedPointer: unknown
      }>
    }
    const modules = new Map(typed.items.map((item) => [item.id, item]))
    expect(modules.get('m_tours')).toMatchObject({
      audience: 'PUBLIC',
      guestVisible: true,
      publishedPointer: { moduleRevisionId: 'rev_tours_1', version: 1, publicationId: 'pub_1' },
    })
    expect(modules.get('m_internal')).toMatchObject({
      audience: 'OPERATOR',
      guestVisible: false,
      publishedPointer: null,
    })
  })
})

describe('content changeset: typed revisions', () => {
  beforeEach(() => {
    vi.stubEnv('GENERALIZED_CONTENT_CAPABILITIES_ENABLED', 'true')
    seed()
  })

  const tourUpdate = {
    op: 'update',
    representation: 'TYPED_REVISION',
    id: 'm_tours',
    expectedRevision: '1',
    draft: {
      audience: 'PUBLIC',
      payload: {
        kind: 'SERVICE',
        name: 'Boat tours',
        description: 'Daily 10 to 3',
        availability: null,
        placeId: null,
      },
    },
    evidence: [{ sourceId: 'src_1', ordinal: 0, locator: 'p1' }],
  } as const

  it('authors a new revision with frozen evidence and does not touch the publication', async () => {
    const resolved = await resolveChangeset(database, scope([tourUpdate]), NOW)
    expect(resolved.ops[0]!.changes).toEqual([
      { field: 'description', before: 'Daily 10 to 4', after: 'Daily 10 to 3' },
    ])
    expect(resolved.ops[0]!.notes.join(' ')).toContain('Guests keep seeing published version 1')
    await applyChangeset(scope([tourUpdate]), applyContext())
    const call = store.calls.find((entry) => entry.action === 'updateTyped')!
    expect(call.input.expectedLatestVersion).toBe(1)
    expect(call.input.draft.evidence).toEqual([
      {
        sourceId: 'venue-source:src_1#0',
        locator: 'p1',
        capturedAt: '2026-09-30T08:00:00.000Z',
        excerptHash: 'a'.repeat(64),
      },
    ])
    expect(store.calls.map((entry) => entry.action)).toEqual(['updateTyped'])
  })

  it('rejects evidence that is not a captured input of this venue', async () => {
    const resolved = await resolveChangeset(
      database,
      scope([{ ...tourUpdate, evidence: [{ sourceId: 'src_missing', ordinal: 0 }] }]),
      NOW,
    )
    expect(changesetProblems(resolved)[0]).toContain('not a source input in this venue')
    store.sourceInputs[0]!.disposition = 'FAILED'
    const failed = await resolveChangeset(database, scope([tourUpdate]), NOW)
    expect(changesetProblems(failed)[0]).toContain('no captured text')
  })

  it('retiring a published module ends it and withdraws the live publication', async () => {
    const retire = {
      op: 'retire',
      representation: 'TYPED_REVISION',
      id: 'm_tours',
      expectedRevision: '1',
      effectiveUntil: '2026-10-02T12:00:00.000Z',
    } as const
    const resolved = await resolveChangeset(database, scope([retire]), NOW)
    expect(resolved.ops[0]!.changes.map((entry) => entry.field)).toEqual([
      'effectiveUntil',
      'publication',
    ])
    await applyChangeset(scope([retire]), applyContext())
    expect(store.calls.map((entry) => entry.action)).toEqual(['retireTyped', 'withdrawTyped'])
    expect(store.calls[1]!.input.expectedPublishedRevisionId).toBe('rev_tours_1')
  })

  it('is refused when generalized content is switched off', async () => {
    vi.stubEnv('GENERALIZED_CONTENT_CAPABILITIES_ENABLED', 'false')
    const resolved = await resolveChangeset(database, scope([tourUpdate]), NOW)
    expect(changesetProblems(resolved)[0]).toContain('disabled for this deployment')
  })

  it('reads a typed module in full, with evidence and its revisions', async () => {
    const get = OPERATOR_READ_TOOLS.find((tool) => tool.name === 'venues.get_content')!
    const result = (await get.handler(
      { tenantId: TENANT, venueId: VENUE, representation: 'TYPED_REVISION', id: 'm_tours' },
      { database, grant, now: NOW } as unknown as OperatorCallContext,
    )) as {
      content: { revision: string }
      fields: Array<{ name: string; value: { untrusted: boolean } }>
      revisions: unknown[]
    }
    expect(result.content.revision).toBe('1')
    expect(result.fields.find((field) => field.name === 'name')).toMatchObject({
      value: { untrusted: true, text: 'Boat tours' },
    })
    expect(result.revisions).toHaveLength(1)
  })
})

describe('content changeset: versions', () => {
  beforeEach(() => seed())

  it('expected version depends only on the named rows and what was expected of them', () => {
    const a = expectedChangesetVersion([
      {
        op: 'retire',
        representation: 'LEGACY_KNOWLEDGE',
        id: 'k_hours',
        expectedRevision: '2026-09-01T10:00:00Z',
      },
    ])
    const b = expectedChangesetVersion([
      {
        op: 'retire',
        representation: 'LEGACY_KNOWLEDGE',
        id: 'k_hours',
        expectedRevision: '2026-09-01T10:00:00.000Z',
      },
    ])
    expect(a).toBe(b)
    expect(a).not.toBe(
      expectedChangesetVersion([
        {
          op: 'retire',
          representation: 'LEGACY_KNOWLEDGE',
          id: 'k_tickets',
          expectedRevision: '2026-09-01T10:00:00.000Z',
        },
      ]),
    )
  })
})
