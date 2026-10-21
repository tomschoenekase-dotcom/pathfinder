import { describe, expect, it, vi } from 'vitest'

import {
  publishUniversalContentAction,
  resolveEffectivePublishedUniversalContent,
  resolveEffectivePublishedUniversalContentSnapshot,
  UniversalContentActionError,
  UniversalContentResolverError,
  withdrawUniversalContentAction,
} from '../index'

const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }

function transactionClient(overrides: Record<string, unknown> = {}) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    contentModulePublication: {
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'publication-1' }),
    },
    contentModuleRevision: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'revision-1',
          moduleId: 'module-1',
          kind: 'POLICY',
          version: 2,
          audience: 'PUBLIC',
        })
        .mockResolvedValueOnce({ id: 'revision-1', version: 2 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    ...overrides,
  }
  return tx
}

function actionClient(tx: ReturnType<typeof transactionClient>) {
  return { $transaction: vi.fn((callback) => callback(tx)) }
}

describe('universal content publication actions', () => {
  it('publishes the exact latest PUBLIC revision with a strict audit in one transaction', async () => {
    const tx = transactionClient()
    const result = await publishUniversalContentAction({
      db: actionClient(tx) as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      moduleId: 'module-1',
      revisionId: 'revision-1',
      expectedLatestVersion: 2,
      requestId: '1c11ddeb-7e31-43d5-a1a8-3f832bbf88aa',
      actor,
    })
    expect(result).toMatchObject({ action: 'PUBLISH', replayed: false })
    expect(tx.contentModulePublication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: 'module-1',
        revisionId: 'revision-1',
        moduleKind: 'POLICY',
        action: 'PUBLISH',
      }),
      select: { id: true },
    })
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })

  it('publishes an exact latest PUBLIC ITEM revision through the same append-only ledger', async () => {
    const tx = transactionClient({
      contentModuleRevision: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'item-r1',
            moduleId: 'item-1',
            kind: 'ITEM',
            version: 1,
            audience: 'PUBLIC',
          })
          .mockResolvedValueOnce({ id: 'item-r1', version: 1 }),
      },
    })
    await publishUniversalContentAction({
      db: actionClient(tx) as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      moduleId: 'item-1',
      revisionId: 'item-r1',
      expectedLatestVersion: 1,
      requestId: 'ef2c5852-c18c-4908-a17b-f289b826ad43',
      actor,
    })
    expect(tx.contentModulePublication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ moduleKind: 'ITEM', action: 'PUBLISH' }),
      select: { id: true },
    })
  })

  it('rejects malformed direct-boundary scope and request IDs before a transaction', async () => {
    const tx = transactionClient()
    const client = actionClient(tx)
    await expect(
      publishUniversalContentAction({
        db: client as never,
        tenantId: ' ',
        venueId: 'venue-1',
        moduleId: 'module-1',
        revisionId: 'revision-1',
        expectedLatestVersion: 2,
        requestId: 'not-a-uuid',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it.each([
    ['missing input', undefined],
    [
      'non-string scope',
      {
        db: actionClient(transactionClient()),
        tenantId: 12,
        venueId: 'venue-1',
        moduleId: 'module-1',
        requestId: '1c11ddeb-7e31-43d5-a1a8-3f832bbf88aa',
        actor,
      },
    ],
    [
      'missing actor',
      {
        db: actionClient(transactionClient()),
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: 'module-1',
        requestId: '1c11ddeb-7e31-43d5-a1a8-3f832bbf88aa',
      },
    ],
    [
      'non-string actor id',
      {
        db: actionClient(transactionClient()),
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: 'module-1',
        requestId: '1c11ddeb-7e31-43d5-a1a8-3f832bbf88aa',
        actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 7 },
      },
    ],
  ])('rejects %s with a typed error before a transaction', async (_label, malformed) => {
    await expect(
      (publishUniversalContentAction as (input: unknown) => Promise<unknown>)(malformed),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects non-PUBLIC revisions before any publication or audit', async () => {
    const tx = transactionClient({
      contentModuleRevision: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'revision-1',
          moduleId: 'module-1',
          kind: 'POLICY',
          version: 2,
          audience: 'OPERATOR',
        }),
      },
    })
    await expect(
      publishUniversalContentAction({
        db: actionClient(tx) as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: 'module-1',
        revisionId: 'revision-1',
        expectedLatestVersion: 2,
        requestId: '1c11ddeb-7e31-43d5-a1a8-3f832bbf88aa',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.contentModulePublication.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('replays only an actor- and input-identical request', async () => {
    const existing = {
      id: 'publication-old',
      venueId: 'venue-1',
      moduleId: 'module-1',
      revisionId: 'revision-1',
      action: 'PUBLISH' as const,
      actorId: 'admin-1',
    }
    const tx = transactionClient({
      contentModulePublication: {
        findFirst: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
      },
    })
    await expect(
      publishUniversalContentAction({
        db: actionClient(tx) as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: 'module-1',
        revisionId: 'revision-other',
        expectedLatestVersion: 2,
        requestId: '1c11ddeb-7e31-43d5-a1a8-3f832bbf88aa',
        actor,
      }),
    ).rejects.toBeInstanceOf(UniversalContentActionError)
    expect(tx.contentModulePublication.create).not.toHaveBeenCalled()
  })

  it('withdraws only the exact currently published revision', async () => {
    const tx = transactionClient({
      contentModulePublication: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
          action: 'PUBLISH',
          revisionId: 'revision-1',
          moduleKind: 'POLICY',
        }),
        create: vi.fn().mockResolvedValue({ id: 'withdrawal-1' }),
      },
    })
    const result = await withdrawUniversalContentAction({
      db: actionClient(tx) as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      moduleId: 'module-1',
      expectedPublishedRevisionId: 'revision-1',
      requestId: '35a7173c-b42b-485b-8885-81355585489e',
      actor,
    })
    expect(result.action).toBe('WITHDRAW')
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })
})

describe('effective published universal content resolver', () => {
  function resolverDb(
    heads: Array<{ moduleId: string; revisionId: string }>,
    revisions: Array<Record<string, unknown>>,
  ) {
    return {
      $queryRaw: vi.fn().mockResolvedValue(heads),
      contentModuleRevision: { findMany: vi.fn().mockResolvedValue(revisions) },
    }
  }

  function operationalRevision(id: string, moduleId: string) {
    return {
      id,
      moduleId,
      kind: 'OPERATIONAL_FACT',
      version: 2,
      audience: 'PUBLIC',
      effectiveFrom: new Date('2026-08-11T17:00:00.000Z'),
      effectiveUntil: new Date('2026-08-11T19:00:00.000Z'),
      item: null,
      service: null,
      policy: null,
      event: null,
      operationalFact: {
        label: 'Entry',
        value: 'North door',
        expiresAt: new Date('2026-08-11T19:00:00.000Z'),
      },
      relationship: null,
    }
  }

  function snapshotRevision(id = 'revision-1', moduleId = 'module-1') {
    return {
      ...operationalRevision(id, moduleId),
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      evidence: [
        {
          id: `evidence-${id}`,
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          revisionId: id,
          moduleKind: 'OPERATIONAL_FACT',
          sourceId: 'official-source',
          locator: 'policy section',
          capturedAt: new Date('2026-08-10T18:00:00.000Z'),
          excerptHash: 'a'.repeat(64),
        },
      ],
    }
  }
  function snapshotDb(revision = snapshotRevision()) {
    const db = resolverDb([], [])
    db.$queryRaw.mockResolvedValue([
      {
        moduleId: revision.moduleId,
        revisionId: revision.id,
        publicationId: 'publication-1',
        publicationOrder: '9007199254740993',
      },
    ])
    db.contentModuleRevision.findMany.mockResolvedValue([revision])
    return db
  }
  const snapshotScope = {
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    asOf: new Date('2026-08-11T18:00:00.000Z'),
  }

  it('returns exact current publication and revision-scoped evidence without BigInt loss', async () => {
    const db = snapshotDb()
    const result = await resolveEffectivePublishedUniversalContentSnapshot({ db, ...snapshotScope })
    expect(result).toEqual([
      {
        moduleId: 'module-1',
        revisionId: 'revision-1',
        kind: 'OPERATIONAL_FACT',
        version: 2,
        payload: {
          kind: 'OPERATIONAL_FACT',
          label: 'Entry',
          value: 'North door',
          expiresAt: '2026-08-11T19:00:00.000Z',
        },
        publicationId: 'publication-1',
        publicationOrder: '9007199254740993',
        audience: 'PUBLIC',
        effectiveFrom: '2026-08-11T17:00:00.000Z',
        effectiveUntil: '2026-08-11T19:00:00.000Z',
        evidence: [
          {
            sourceId: 'official-source',
            locator: 'policy section',
            capturedAt: '2026-08-10T18:00:00.000Z',
            excerptHash: 'a'.repeat(64),
          },
        ],
      },
    ])
    expect(db.contentModuleRevision.findMany.mock.calls[0]![0]).toMatchObject({
      where: { tenantId: 'tenant-1', venueId: 'venue-1', id: { in: ['revision-1'] } },
      select: {
        tenantId: true,
        venueId: true,
        evidence: { select: { revisionId: true, moduleKind: true } },
      },
    })
  })

  it('preserves legacy result keys and expired-operational-fact behavior', async () => {
    const revision = snapshotRevision()
    revision.operationalFact!.expiresAt = snapshotScope.asOf
    const db = snapshotDb(revision)
    expect(
      await resolveEffectivePublishedUniversalContentSnapshot({ db, ...snapshotScope }),
    ).toEqual([])
    const legacy = await resolveEffectivePublishedUniversalContent({ db, ...snapshotScope })
    expect(legacy).toHaveLength(1)
    expect(Object.keys(legacy[0]!).sort()).toEqual([
      'kind',
      'moduleId',
      'payload',
      'revisionId',
      'version',
    ])
    expect(db.contentModuleRevision.findMany.mock.calls[1]![0].select).not.toHaveProperty(
      'evidence',
    )
  })

  it('keeps null evidence locators/hashes and supports an explicitly empty evidence array', async () => {
    const revision = snapshotRevision()
    revision.evidence[0]!.locator = null as never
    revision.evidence[0]!.excerptHash = null as never
    const db = snapshotDb(revision)
    expect(
      (await resolveEffectivePublishedUniversalContentSnapshot({ db, ...snapshotScope }))[0]!
        .evidence[0],
    ).toMatchObject({ locator: null, excerptHash: null })
    revision.evidence = []
    expect(
      (await resolveEffectivePublishedUniversalContentSnapshot({ db, ...snapshotScope }))[0]!
        .evidence,
    ).toEqual([])
  })

  it('supports 10000 detailed heads with scoped batches and exact publication identities', async () => {
    const heads = Array.from({ length: 10000 }, (_, i) => ({
      moduleId: `m-${String(i).padStart(5, '0')}`,
      revisionId: `r-${i}`,
      publicationId: `p-${i}`,
      publicationOrder: String(i + 1),
    }))
    const db = resolverDb([], [])
    db.$queryRaw.mockResolvedValue(heads)
    db.contentModuleRevision.findMany.mockImplementation(async (args) =>
      args.where.id.in.map((id: string) => {
        const i = Number(id.slice(2))
        return { ...snapshotRevision(id, heads[i]!.moduleId), evidence: [] }
      }),
    )
    const result = await resolveEffectivePublishedUniversalContentSnapshot({ db, ...snapshotScope })
    expect(result).toHaveLength(10000)
    expect(result[9999]!.publicationId).toBe('p-9999')
    expect(db.$queryRaw).toHaveBeenCalledOnce()
    expect(db.contentModuleRevision.findMany).toHaveBeenCalledTimes(20)
  })

  it('rejects evidence overflow rather than truncating a revision proof', async () => {
    const revision = snapshotRevision()
    revision.evidence = Array.from({ length: 101 }, (_, index) => ({
      ...revision.evidence[0]!,
      id: `e-${index}`,
      locator: `section-${index}`,
    }))
    await expect(
      resolveEffectivePublishedUniversalContentSnapshot({
        db: snapshotDb(revision),
        ...snapshotScope,
      }),
    ).rejects.toThrow('revision evidence is invalid')
  })

  it('preserves effective date boundaries and rejects malformed operational expiry', async () => {
    const revision = snapshotRevision()
    revision.effectiveFrom = snapshotScope.asOf
    expect(
      await resolveEffectivePublishedUniversalContentSnapshot({
        db: snapshotDb(revision),
        ...snapshotScope,
      }),
    ).toHaveLength(1)
    revision.effectiveFrom = new Date('2026-08-11T17:00:00.000Z')
    revision.effectiveUntil = snapshotScope.asOf
    expect(
      await resolveEffectivePublishedUniversalContentSnapshot({
        db: snapshotDb(revision),
        ...snapshotScope,
      }),
    ).toEqual([])
    revision.effectiveUntil = new Date('2026-08-11T19:00:00.000Z')
    revision.operationalFact!.expiresAt = new Date('invalid')
    await expect(
      resolveEffectivePublishedUniversalContentSnapshot({
        db: snapshotDb(revision),
        ...snapshotScope,
      }),
    ).rejects.toBeInstanceOf(UniversalContentResolverError)
  })

  it.each([
    ['missing publication', { publicationId: undefined }],
    ['invalid publication order', { publicationOrder: '1.5' }],
    ['zero publication order', { publicationOrder: '0' }],
    ['numeric publication order', { publicationOrder: 123 }],
  ])('fails closed for %s in detailed heads', async (_label, patch) => {
    const db = snapshotDb()
    db.$queryRaw.mockResolvedValue([
      {
        moduleId: 'module-1',
        revisionId: 'revision-1',
        publicationId: 'p-1',
        publicationOrder: '1',
        ...patch,
      },
    ])
    await expect(
      resolveEffectivePublishedUniversalContentSnapshot({ db, ...snapshotScope }),
    ).rejects.toBeInstanceOf(UniversalContentResolverError)
    expect(db.contentModuleRevision.findMany).not.toHaveBeenCalled()
  })

  it.each(['publicationId', 'publicationOrder'])(
    'rejects duplicate %s across detailed heads',
    async (field) => {
      const db = snapshotDb()
      db.$queryRaw.mockResolvedValue([
        { moduleId: 'm-1', revisionId: 'r-1', publicationId: 'p-1', publicationOrder: '1' },
        {
          moduleId: 'm-2',
          revisionId: 'r-2',
          publicationId: field === 'publicationId' ? 'p-1' : 'p-2',
          publicationOrder: field === 'publicationOrder' ? '1' : '2',
        },
      ])
      await expect(
        resolveEffectivePublishedUniversalContentSnapshot({ db, ...snapshotScope }),
      ).rejects.toBeInstanceOf(UniversalContentResolverError)
    },
  )

  it.each([
    'missing',
    'duplicate',
    'scope',
    'version',
    'date',
    'payload',
    'evidence-missing',
    'evidence-scope',
    'evidence-revision',
    'evidence-kind',
    'evidence-date',
    'evidence-hash',
    'evidence-duplicate',
    'evidence-id-duplicate',
  ])('rejects malformed detailed %s', async (change) => {
    const revision = snapshotRevision()
    const db = snapshotDb(revision)
    if (change === 'missing') db.contentModuleRevision.findMany.mockResolvedValue([])
    if (change === 'duplicate')
      db.contentModuleRevision.findMany.mockResolvedValue([revision, revision])
    if (change === 'scope') revision.tenantId = 'other-tenant'
    if (change === 'version') revision.version = 0
    if (change === 'date') revision.effectiveUntil = new Date('invalid')
    if (change === 'payload') revision.operationalFact!.value = ''
    if (change === 'evidence-missing') revision.evidence = undefined as never
    if (change === 'evidence-scope') revision.evidence[0]!.venueId = 'other-venue'
    if (change === 'evidence-revision') revision.evidence[0]!.revisionId = 'other-revision'
    if (change === 'evidence-kind') revision.evidence[0]!.moduleKind = 'POLICY'
    if (change === 'evidence-date') revision.evidence[0]!.capturedAt = new Date('invalid')
    if (change === 'evidence-hash') revision.evidence[0]!.excerptHash = 'invalid'
    if (change === 'evidence-duplicate')
      revision.evidence.push({ ...revision.evidence[0]!, id: 'another-id' })
    if (change === 'evidence-id-duplicate')
      revision.evidence.push({ ...revision.evidence[0]!, locator: 'another-locator' })
    await expect(
      resolveEffectivePublishedUniversalContentSnapshot({ db, ...snapshotScope }),
    ).rejects.toBeInstanceOf(UniversalContentResolverError)
  })

  it('selects latest events before filtering publication and never hydrates withdrawn predecessors', async () => {
    const db = resolverDb([], [])
    expect(
      await resolveEffectivePublishedUniversalContentSnapshot({ db, ...snapshotScope }),
    ).toEqual([])
    expect(db.contentModuleRevision.findMany).not.toHaveBeenCalled()
    const sql = (db.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('?')
    const split = sql.indexOf(') AS latest')
    expect(sql.slice(0, split)).toContain('publication."event_order" DESC')
    expect(sql.slice(0, split)).not.toContain("'PUBLISH'")
    expect(sql.slice(split)).toContain('WHERE latest."action"')
    expect(sql).toContain('AS "publicationId"')
    expect(sql).toContain('::text AS "publicationOrder"')
  })

  it.each([
    ['missing input', undefined],
    [
      'missing tenant scope',
      {
        db: { $queryRaw: vi.fn(), contentModuleRevision: { findMany: vi.fn() } },
        venueId: 'venue-1',
      },
    ],
    [
      'invalid date',
      {
        db: { $queryRaw: vi.fn(), contentModuleRevision: { findMany: vi.fn() } },
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        asOf: new Date('invalid'),
      },
    ],
  ])('rejects %s before querying', async (_label, malformed) => {
    await expect(
      (resolveEffectivePublishedUniversalContent as (input: unknown) => Promise<unknown>)(
        malformed,
      ),
    ).rejects.toBeInstanceOf(UniversalContentResolverError)
  })

  it('resolves exact latest published heads without scanning publication history', async () => {
    const now = new Date('2026-08-11T18:00:00.000Z')
    const db = resolverDb(
      [{ moduleId: 'active', revisionId: 'active-r2' }],
      [operationalRevision('active-r2', 'active')],
    )
    const result = await resolveEffectivePublishedUniversalContent({
      db: db as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      asOf: now,
    })
    expect(result).toEqual([
      expect.objectContaining({ moduleId: 'active', revisionId: 'active-r2', version: 2 }),
    ])
    expect(db.contentModuleRevision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          id: { in: ['active-r2'] },
        },
      }),
    )
  })

  it('resolves only the exact typed ITEM sidecar for a current PUBLIC head', async () => {
    const revision = {
      ...operationalRevision('item-r3', 'item-module'),
      kind: 'ITEM',
      item: {
        name: 'Apollo guidance computer',
        description: 'A preserved flight computer.',
        placeId: 'place-1',
        itemType: 'artifact',
      },
      operationalFact: null,
    }
    const db = resolverDb([{ moduleId: 'item-module', revisionId: 'item-r3' }], [revision])
    await expect(
      resolveEffectivePublishedUniversalContent({
        db: db as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        asOf: new Date('2026-08-11T18:00:00.000Z'),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        moduleId: 'item-module',
        revisionId: 'item-r3',
        kind: 'ITEM',
        payload: {
          kind: 'ITEM',
          name: 'Apollo guidance computer',
          description: 'A preserved flight computer.',
          placeId: 'place-1',
          itemType: 'artifact',
        },
      }),
    ])
    expect(db.contentModuleRevision.findMany.mock.calls[0]?.[0]?.select.item).toBe(true)
  })

  it('fails closed when a published ITEM has no exact typed sidecar', async () => {
    const revision = {
      ...operationalRevision('item-r3', 'item-module'),
      kind: 'ITEM',
      item: null,
      operationalFact: null,
    }
    const db = resolverDb([{ moduleId: 'item-module', revisionId: 'item-r3' }], [revision])
    await expect(
      resolveEffectivePublishedUniversalContent({
        db: db as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        asOf: new Date('2026-08-11T18:00:00.000Z'),
      }),
    ).rejects.toThrow('A published revision has no typed payload.')
  })

  it('keeps resolving one current head after more than 500 events for that module', async () => {
    const db = resolverDb(
      [{ moduleId: 'noisy', revisionId: 'noisy-r501' }],
      [operationalRevision('noisy-r501', 'noisy')],
    )
    await expect(
      resolveEffectivePublishedUniversalContent({
        db: db as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        asOf: new Date('2026-08-11T18:00:00.000Z'),
      }),
    ).resolves.toHaveLength(1)
    expect(db.$queryRaw).toHaveBeenCalledOnce()
    const sql = (db.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?')
    expect(sql).toContain('SELECT DISTINCT ON (publication."module_id")')
    expect(sql).toContain('ORDER BY publication."module_id" ASC, publication."event_order" DESC')
    expect(sql).toContain('WHERE latest."action" = \'PUBLISH\'')
    expect(sql).toContain('ORDER BY latest."module_id" ASC')
    expect(sql).toContain('LIMIT ?')
    expect(db.$queryRaw.mock.calls[0]?.slice(1)).toEqual(['tenant-1', 'venue-1', 10001])
  })

  it('resolves 10000 current modules from one head snapshot with bounded revision batches', async () => {
    const heads = Array.from({ length: 10_000 }, (_, index) => ({
      moduleId: `module-${String(index).padStart(5, '0')}`,
      revisionId: `revision-${index}`,
    }))
    const revisions = new Map(
      heads.map((head) => [head.revisionId, operationalRevision(head.revisionId, head.moduleId)]),
    )
    const db = resolverDb(heads, [])
    db.contentModuleRevision.findMany.mockImplementation(async (args) =>
      args.where.id.in.map((id: string) => revisions.get(id)),
    )
    const result = await resolveEffectivePublishedUniversalContent({
      db,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      asOf: new Date('2026-08-11T18:00:00.000Z'),
    })
    expect(result.map((row) => row.moduleId)).toEqual(heads.map((head) => head.moduleId))
    expect(db.$queryRaw).toHaveBeenCalledOnce()
    expect(db.contentModuleRevision.findMany).toHaveBeenCalledTimes(20)
    for (const [args] of db.contentModuleRevision.findMany.mock.calls) {
      expect(args.where).toEqual({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        id: { in: expect.any(Array) },
      })
      expect(args.where.id.in).toHaveLength(500)
    }
  })

  it('suppresses an older publication when the newest event withdraws it', async () => {
    // The database returns only current PUBLISH heads. Keep the older revision
    // available to prove hydration cannot accidentally revive it.
    const db = resolverDb(
      [{ moduleId: 'active', revisionId: 'active-r2' }],
      [operationalRevision('active-r2', 'active')],
    )
    const retired = operationalRevision('withdrawn-r1', 'withdrawn')
    db.contentModuleRevision.findMany.mockImplementation(async (args) =>
      [operationalRevision('active-r2', 'active'), retired].filter((revision) =>
        args.where.id.in.includes(revision.id),
      ),
    )
    const result = await resolveEffectivePublishedUniversalContent({
      db,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      asOf: new Date('2026-08-11T18:00:00.000Z'),
    })
    expect(result.map((row) => row.moduleId)).toEqual(['active'])
    const sql = (db.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?')
    const latestSelectionEnd = sql.indexOf(') AS latest')
    expect(latestSelectionEnd).toBeGreaterThan(0)
    expect(sql.slice(0, latestSelectionEnd)).toContain('publication."event_order" DESC')
    expect(sql.slice(0, latestSelectionEnd)).not.toContain("'PUBLISH'")
    expect(sql.slice(latestSelectionEnd)).toContain('WHERE latest."action" = \'PUBLISH\'')
  })

  it('rejects the whole read if a later revision batch fails', async () => {
    const heads = Array.from({ length: 501 }, (_, index) => ({
      moduleId: `module-${index}`,
      revisionId: `revision-${index}`,
    }))
    const db = resolverDb(heads, [])
    db.contentModuleRevision.findMany
      .mockResolvedValueOnce(
        heads.slice(0, 500).map((head) => operationalRevision(head.revisionId, head.moduleId)),
      )
      .mockRejectedValueOnce(new Error('revision read failed'))
    await expect(
      resolveEffectivePublishedUniversalContent({
        db,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
      }),
    ).rejects.toThrow('revision read failed')
  })

  it.each([0, 10001, 1.5])('rejects invalid maximum %s before querying', async (maximumModules) => {
    const db = resolverDb([], [])
    await expect(
      resolveEffectivePublishedUniversalContent({
        db,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        maximumModules,
      }),
    ).rejects.toBeInstanceOf(UniversalContentResolverError)
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it('rejects overflow at the hard bound before hydrating revisions', async () => {
    const db = resolverDb(
      Array.from({ length: 10_001 }, (_, index) => ({
        moduleId: `module-${index}`,
        revisionId: `revision-${index}`,
      })),
      [],
    )
    await expect(
      resolveEffectivePublishedUniversalContent({
        db,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
      }),
    ).rejects.toThrow('Published content module count exceeds safe bounds.')
    expect(db.contentModuleRevision.findMany).not.toHaveBeenCalled()
  })

  it('does not load revisions for latest WITHDRAW heads or noisy withdrawn history', async () => {
    const db = resolverDb([], [])
    await expect(
      resolveEffectivePublishedUniversalContent({
        db: db as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
      }),
    ).resolves.toEqual([])
    expect(db.contentModuleRevision.findMany).not.toHaveBeenCalled()
  })

  it('fails closed when current published heads exceed the requested bound', async () => {
    const db = resolverDb(
      Array.from({ length: 51 }, (_, index) => ({
        moduleId: `module-${index}`,
        revisionId: `revision-${index}`,
      })),
      [],
    )
    await expect(
      resolveEffectivePublishedUniversalContent({
        db: db as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        maximumModules: 50,
      }),
    ).rejects.toThrow('Published content module count exceeds safe bounds.')
    expect(db.contentModuleRevision.findMany).not.toHaveBeenCalled()
  })

  it('fails closed for a missing or cross-scope typed revision', async () => {
    const db = resolverDb([{ moduleId: 'module-1', revisionId: 'revision-1' }], [])
    await expect(
      resolveEffectivePublishedUniversalContent({
        db: db as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
      }),
    ).rejects.toThrow('A published revision is missing or out of scope.')
  })

  it('fails closed when the exact published revision has no payload for its declared kind', async () => {
    const revision = {
      ...operationalRevision('revision-1', 'module-1'),
      operationalFact: null,
    }
    const db = resolverDb([{ moduleId: 'module-1', revisionId: 'revision-1' }], [revision])
    await expect(
      resolveEffectivePublishedUniversalContent({
        db: db as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        asOf: new Date('2026-08-11T18:00:00.000Z'),
      }),
    ).rejects.toThrow('A published revision has no typed payload.')
  })

  it('includes an exact effective start and excludes an exact effective end', async () => {
    const boundary = new Date('2026-08-11T18:00:00.000Z')
    const starting = { ...operationalRevision('start-r1', 'starting'), effectiveFrom: boundary }
    const ending = { ...operationalRevision('end-r1', 'ending'), effectiveUntil: boundary }
    const db = resolverDb(
      [
        { moduleId: 'ending', revisionId: 'end-r1' },
        { moduleId: 'starting', revisionId: 'start-r1' },
      ],
      [ending, starting],
    )
    await expect(
      resolveEffectivePublishedUniversalContent({
        db: db as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        asOf: boundary,
      }),
    ).resolves.toEqual([expect.objectContaining({ moduleId: 'starting' })])
  })

  it.each([
    [
      'duplicate module heads',
      [
        { moduleId: 'module-1', revisionId: 'revision-1' },
        { moduleId: 'module-1', revisionId: 'revision-2' },
      ],
    ],
    [
      'one revision attached to two modules',
      [
        { moduleId: 'module-1', revisionId: 'revision-1' },
        { moduleId: 'module-2', revisionId: 'revision-1' },
      ],
    ],
    ['blank head identity', [{ moduleId: '', revisionId: 'revision-1' }]],
  ])('fails closed for %s returned by the head query', async (_label, heads) => {
    const db = resolverDb(heads, [])
    await expect(
      resolveEffectivePublishedUniversalContent({
        db: db as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
      }),
    ).rejects.toThrow('Published content heads are inconsistent.')
  })
})

describe('governed relationship publication authority', () => {
  const input = {
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    moduleId: 'edge',
    revisionId: 'edge-r1',
    expectedLatestVersion: 1,
    requestId: '1c11ddeb-7e31-43d5-a1a8-3f832bbf88aa',
    actor,
  }
  function relationshipTx(type = 'OFFERS_PRODUCT_V1', subtype = 'PRODUCT') {
    const tx = transactionClient({
      relationshipContent: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ fromModuleId: 'from', toModuleId: 'to', relationshipType: type }),
      },
    })
    tx.contentModuleRevision.findFirst
      .mockReset()
      .mockResolvedValueOnce({
        id: 'edge-r1',
        kind: 'RELATIONSHIP',
        version: 1,
        audience: 'PUBLIC',
      })
      .mockResolvedValueOnce({ id: 'edge-r1', version: 1 })
      .mockResolvedValueOnce({
        kind: type === 'EXCEPTION_TO_V1' ? 'POLICY' : 'SERVICE',
        audience: 'PUBLIC',
        effectiveFrom: null,
        effectiveUntil: null,
      })
      .mockResolvedValueOnce({
        kind: type === 'EXCEPTION_TO_V1' ? 'POLICY' : 'ITEM',
        audience: 'PUBLIC',
        effectiveFrom: null,
        effectiveUntil: null,
        item: { itemType: subtype },
      })
    tx.contentModulePublication.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ action: 'PUBLISH', revisionId: 'from-published' })
      .mockResolvedValueOnce({ action: 'PUBLISH', revisionId: 'to-published' })
    return tx
  }
  it.each(['OFFERS_PRODUCT_V1', 'EXCEPTION_TO_V1'])(
    'publishes valid %s against exact scoped published endpoints',
    async (type) => {
      const tx = relationshipTx(type)
      await expect(
        publishUniversalContentAction({ ...input, db: actionClient(tx) as never }),
      ).resolves.toMatchObject({ action: 'PUBLISH' })
      expect(tx.contentModuleRevision.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'to-published', tenantId: 'tenant-1', venueId: 'venue-1', moduleId: 'to' },
        }),
      )
    },
  )
  it('rejects the published non-PRODUCT subtype even when a newer draft could be PRODUCT', async () => {
    const tx = relationshipTx('OFFERS_PRODUCT_V1', 'MENU_ITEM')
    await expect(
      publishUniversalContentAction({ ...input, db: actionClient(tx) as never }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.contentModulePublication.create).not.toHaveBeenCalled()
  })
  it('rejects withdrawn endpoint publication', async () => {
    const tx = relationshipTx()
    tx.contentModulePublication.findFirst
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ action: 'WITHDRAW', revisionId: 'from-published' })
    await expect(
      publishUniversalContentAction({ ...input, db: actionClient(tx) as never }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.contentModulePublication.create).not.toHaveBeenCalled()
  })
  it.each([
    { kind: 'ITEM', audience: 'PUBLIC', effectiveFrom: null, effectiveUntil: null },
    { kind: 'SERVICE', audience: 'CLIENT', effectiveFrom: null, effectiveUntil: null },
    {
      kind: 'SERVICE',
      audience: 'PUBLIC',
      effectiveFrom: new Date('2999-01-01'),
      effectiveUntil: null,
    },
    {
      kind: 'SERVICE',
      audience: 'PUBLIC',
      effectiveFrom: null,
      effectiveUntil: new Date('2000-01-01'),
    },
    null,
  ])(
    'rejects incompatible, private, ineffective, or absent scoped endpoints: %j',
    async (endpoint) => {
      const tx = relationshipTx()
      tx.contentModuleRevision.findFirst
        .mockReset()
        .mockResolvedValueOnce({
          id: 'edge-r1',
          kind: 'RELATIONSHIP',
          version: 1,
          audience: 'PUBLIC',
        })
        .mockResolvedValueOnce({ id: 'edge-r1', version: 1 })
        .mockResolvedValueOnce(endpoint)
        .mockResolvedValueOnce({
          kind: 'ITEM',
          audience: 'PUBLIC',
          effectiveFrom: null,
          effectiveUntil: null,
          item: { itemType: 'PRODUCT' },
        })
      await expect(
        publishUniversalContentAction({ ...input, db: actionClient(tx) as never }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(tx.contentModulePublication.create).not.toHaveBeenCalled()
    },
  )
  it.each([
    ['future edge and endpoints', new Date('2999-01-01'), new Date('2999-01-01'), null, true],
    ['active edge and future endpoints', null, new Date('2999-01-01'), null, false],
    [
      'endpoints ended before edge starts',
      new Date('2999-01-02'),
      null,
      new Date('2999-01-01'),
      false,
    ],
    [
      'endpoints need not cover full edge interval',
      new Date('2999-01-01'),
      null,
      new Date('2999-01-02'),
      true,
    ],
  ] as const)(
    'scheduled authority: %s',
    async (_label, effectiveFrom, endpointStart, endpointEnd, valid) => {
      const tx = relationshipTx()
      tx.contentModuleRevision.findFirst
        .mockReset()
        .mockResolvedValueOnce({
          id: 'edge-r1',
          kind: 'RELATIONSHIP',
          version: 1,
          audience: 'PUBLIC',
          effectiveFrom,
          effectiveUntil: null,
        })
        .mockResolvedValueOnce({ id: 'edge-r1', version: 1 })
        .mockResolvedValueOnce({
          kind: 'SERVICE',
          audience: 'PUBLIC',
          effectiveFrom: endpointStart,
          effectiveUntil: endpointEnd,
        })
        .mockResolvedValueOnce({
          kind: 'ITEM',
          audience: 'PUBLIC',
          effectiveFrom: endpointStart,
          effectiveUntil: endpointEnd,
          item: { itemType: 'PRODUCT' },
        })
      const action = publishUniversalContentAction({ ...input, db: actionClient(tx) as never })
      if (valid) await expect(action).resolves.toMatchObject({ action: 'PUBLISH' })
      else {
        await expect(action).rejects.toMatchObject({ code: 'INVALID_INPUT' })
        expect(tx.contentModulePublication.create).not.toHaveBeenCalled()
      }
    },
  )
  it('publishes an ended retirement revision after endpoint withdrawal, retaining scoped kinds', async () => {
    const tx = relationshipTx()
    Object.assign(tx, {
      contentModuleIdentity: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'from', kind: 'SERVICE' },
          { id: 'to', kind: 'ITEM' },
        ]),
      },
    })
    tx.contentModuleRevision.findFirst
      .mockReset()
      .mockResolvedValueOnce({
        id: 'edge-r1',
        kind: 'RELATIONSHIP',
        version: 1,
        audience: 'PUBLIC',
        effectiveFrom: null,
        effectiveUntil: new Date('2000-01-01'),
      })
      .mockResolvedValueOnce({ id: 'edge-r1', version: 1 })
    tx.contentModulePublication.findFirst
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ action: 'WITHDRAW', revisionId: 'from-published' })
    await expect(
      publishUniversalContentAction({ ...input, db: actionClient(tx) as never }),
    ).resolves.toMatchObject({ action: 'PUBLISH' })
    expect(tx.contentModulePublication.findFirst).toHaveBeenCalledTimes(1)
  })
  it('does not bypass scoped kind validation for ended retirement revisions', async () => {
    const tx = relationshipTx()
    Object.assign(tx, {
      contentModuleIdentity: {
        findMany: vi.fn().mockResolvedValue([{ id: 'from', kind: 'POLICY' }]),
      },
    })
    tx.contentModuleRevision.findFirst
      .mockReset()
      .mockResolvedValueOnce({
        id: 'edge-r1',
        kind: 'RELATIONSHIP',
        version: 1,
        audience: 'PUBLIC',
        effectiveFrom: null,
        effectiveUntil: new Date('2000-01-01'),
      })
      .mockResolvedValueOnce({ id: 'edge-r1', version: 1 })
    await expect(
      publishUniversalContentAction({ ...input, db: actionClient(tx) as never }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.contentModulePublication.create).not.toHaveBeenCalled()
  })
  it('preserves unknown vocabulary without requiring published endpoints', async () => {
    const tx = relationshipTx('CUSTOM_RELATIONSHIP')
    await expect(
      publishUniversalContentAction({ ...input, db: actionClient(tx) as never }),
    ).resolves.toMatchObject({ action: 'PUBLISH' })
    expect(tx.contentModulePublication.findFirst).toHaveBeenCalledTimes(1)
  })
})
