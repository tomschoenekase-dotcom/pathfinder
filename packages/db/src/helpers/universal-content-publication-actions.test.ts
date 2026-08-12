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
  it.each([
    ['missing input', undefined],
    [
      'missing tenant scope',
      { db: { contentModulePublication: { findMany: vi.fn() } }, venueId: 'venue-1' },
    ],
    [
      'invalid date',
      {
        db: { contentModulePublication: { findMany: vi.fn() } },
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

  it('uses only the latest publication event and filters future/expired revisions', async () => {
    const now = new Date('2026-08-11T18:00:00.000Z')
    const db = {
      contentModulePublication: {
        findMany: vi.fn().mockResolvedValue([
          {
            moduleId: 'withdrawn',
            revisionId: 'withdrawn-r1',
            action: 'WITHDRAW',
            revision: { audience: 'PUBLIC' },
          },
          {
            moduleId: 'active',
            revisionId: 'active-r2',
            action: 'PUBLISH',
            revision: {
              kind: 'OPERATIONAL_FACT',
              version: 2,
              audience: 'PUBLIC',
              effectiveFrom: new Date('2026-08-11T17:00:00.000Z'),
              effectiveUntil: new Date('2026-08-11T19:00:00.000Z'),
              service: null,
              policy: null,
              event: null,
              operationalFact: {
                label: 'Entry',
                value: 'North door',
                expiresAt: new Date('2026-08-11T19:00:00.000Z'),
              },
              relationship: null,
            },
          },
        ]),
      },
    }
    const result = await resolveEffectivePublishedUniversalContent({
      db: db as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      asOf: now,
    })
    expect(result).toEqual([
      expect.objectContaining({ moduleId: 'active', revisionId: 'active-r2', version: 2 }),
    ])
    expect(db.contentModulePublication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', venueId: 'venue-1' },
        orderBy: { eventOrder: 'desc' },
        take: 501,
      }),
    )
  })
})
