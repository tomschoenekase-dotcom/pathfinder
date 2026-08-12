import { describe, expect, it, vi } from 'vitest'

import {
  publishUniversalContentAction,
  resolveEffectivePublishedUniversalContent,
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
    expect(db.$queryRaw.mock.calls[0]?.slice(1)).toEqual(['tenant-1', 'venue-1', 101])
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
