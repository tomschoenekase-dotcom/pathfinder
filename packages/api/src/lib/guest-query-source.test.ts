import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveEffectivePublishedUniversalContentSnapshot } from '@pathfinder/db'
import { loadGuestQuerySourceDirectory } from './guest-query-source-directory'
import type { GuestVenueDirectory } from './guest-venue-directory'
import {
  loadGuestQuerySource,
  MAX_GUEST_QUERY_SOURCE_BYTES,
  GUEST_QUERY_SOURCE_CONTRACT,
  type GuestQueryTransactionClient,
} from './guest-query-source'
vi.mock('./guest-query-source-directory', () => ({ loadGuestQuerySourceDirectory: vi.fn() }))
vi.mock('@pathfinder/db', () => ({ resolveEffectivePublishedUniversalContentSnapshot: vi.fn() }))
const scope = {
  tenantId: 'tenant-fictional',
  venueId: 'venue-fictional',
  includeSecondLayer: false,
  asOf: new Date('2026-10-21T05:00:00.000Z'),
}
function directory(): GuestVenueDirectory {
  return {
    incomplete: false,
    places: [
      {
        id: 'shared-id',
        name: 'Clock Gallery',
        type: 'EXHIBIT',
        itemType: 'gallery',
        shortDescription: 'Historic clocks.',
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
      },
    ],
    knowledge: [
      {
        id: 'shared-id',
        title: 'Admission',
        category: 'VISIT',
        content: 'Admission requires a ticket.',
        sourceType: 'MANUAL',
        sourceName: null,
        sourceUrl: null,
      },
    ],
  }
}

function client() {
  const reader = { marker: 'transaction' }
  const transaction = vi.fn(async (read: (value: unknown) => Promise<unknown>) => read(reader))
  return { reader, transaction, db: { $transaction: transaction } as GuestQueryTransactionClient }
}
const loadDirectory = vi.mocked(loadGuestQuerySourceDirectory),
  loadModules = vi.mocked(resolveEffectivePublishedUniversalContentSnapshot)
const loaded = () => ({
  directory: directory(),
  authority: { knowledge: [], places: [], activatedLegacyIds: [] as string[] },
})
beforeEach(() => {
  vi.resetAllMocks()
  loadDirectory.mockResolvedValue(loaded())
  loadModules.mockResolvedValue([])
})
describe('structured source authority v2', () => {
  it.each(['LEGACY', 'DARK'] as const)(
    'one current snapshot and one directory read in %s RR',
    async (readPath) => {
      const c = client()
      const r = await loadGuestQuerySource({ client: c.db, scope, readPath })
      expect(c.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
        isolationLevel: 'RepeatableRead',
        timeout: 15000,
      })
      expect(loadModules).toHaveBeenCalledExactlyOnceWith({
        db: c.reader,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        asOf: scope.asOf,
      })
      expect(loadDirectory).toHaveBeenCalledExactlyOnceWith({
        ...scope,
        reader: c.reader,
        modules: [],
      })
      expect(loadModules.mock.invocationCallOrder[0]).toBeLessThan(
        loadDirectory.mock.invocationCallOrder[0]!,
      )
      expect(r.directory).toEqual({ ...directory(), searchVersion: r.version })
      expect(r.version).toMatch(/^[a-f0-9]{64}$/)
      expect(GUEST_QUERY_SOURCE_CONTRACT).toBe('guest-query-source-authority-v2')
    },
  )
  it('fails unsupported RR without an outside read', async () => {
    const c = client()
    c.transaction.mockRejectedValueOnce(Error('RR unavailable'))
    await expect(loadGuestQuerySource({ client: c.db, scope, readPath: 'LEGACY' })).rejects.toThrow(
      'RR unavailable',
    )
    expect(loadDirectory).not.toHaveBeenCalled()
    expect(loadModules).not.toHaveBeenCalled()
  })
  it('rejects native before any read', async () => {
    const c = client()
    await expect(
      loadGuestQuerySource({ client: c.db, scope, readPath: 'NATIVE' as never }),
    ).rejects.toThrow('admitted native')
    expect(c.transaction).not.toHaveBeenCalled()
  })
  it.each(['canonical', 'directory'])('fails %s without retry', async (stage) => {
    if (stage === 'canonical') loadModules.mockRejectedValueOnce(Error('read failed'))
    else loadDirectory.mockRejectedValueOnce(Error('read failed'))
    const c = client()
    await expect(loadGuestQuerySource({ client: c.db, scope, readPath: 'LEGACY' })).rejects.toThrow(
      'read failed',
    )
    expect(c.transaction).toHaveBeenCalledOnce()
    expect(loadModules).toHaveBeenCalledOnce()
    expect(loadDirectory).toHaveBeenCalledTimes(stage === 'canonical' ? 0 : 1)
  })
  it.each(['places', 'knowledge'] as const)('rejects duplicate %s', async (kind) => {
    const v = loaded()
    if (kind === 'places') v.directory.places.push({ ...v.directory.places[0]! })
    else v.directory.knowledge.push({ ...v.directory.knowledge[0]! })
    loadDirectory.mockResolvedValueOnce(v)
    await expect(
      loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' }),
    ).rejects.toThrow('Duplicate guest query source identity')
  })
  it('allows one ID in different domains', async () => {
    const r = await loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' })
    expect(r.directory.places[0]!.id).toBe(r.directory.knowledge[0]!.id)
  })
  it('rejects incomplete membership', async () => {
    loadDirectory.mockResolvedValueOnce({
      ...loaded(),
      directory: { ...directory(), incomplete: true },
    })
    await expect(
      loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' }),
    ).rejects.toThrow('Incomplete guest query source')
  })
  it('rejects UTF8 bound without truncation', async () => {
    const v = loaded()
    v.directory.knowledge[0]!.content = '\u754c'.repeat(Math.ceil(MAX_GUEST_QUERY_SOURCE_BYTES / 3))
    loadDirectory.mockResolvedValueOnce(v)
    await expect(
      loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' }),
    ).rejects.toThrow('Guest query source exceeds byte bound')
  })
  it('stable later asOf for unchanged admitted facts and authority', async () => {
    const a = await loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' })
    const b = await loadGuestQuerySource({
      client: client().db,
      scope: { ...scope, asOf: new Date('2026-10-21T05:01:00Z') },
      readPath: 'LEGACY',
    })
    expect(a.version).toBe(b.version)
    expect(a.asOf).not.toBe(b.asOf)
  })
  it.each([
    'body',
    'membership',
    'authority',
    'tenant',
    'venue',
    'audience',
    'path',
    'contentModuleId',
    'contentRevisionId',
    'contentPublicationId',
  ])('binds %s', async (change) => {
    const first = await loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' })
    const nextScope = { ...scope }
    const v = loaded()
    if (change === 'body') v.directory.knowledge[0]!.content = 'Free admission.'
    if (change === 'membership') v.directory.knowledge = []
    if (change === 'authority') v.authority.activatedLegacyIds.push('activation')
    if (
      change === 'contentModuleId' ||
      change === 'contentRevisionId' ||
      change === 'contentPublicationId'
    )
      v.directory.knowledge[0]![change] = 'changed'
    loadDirectory.mockResolvedValueOnce(v)
    if (change === 'tenant') nextScope.tenantId = 'tenant-other'
    if (change === 'venue') nextScope.venueId = 'venue-other'
    if (change === 'audience') nextScope.includeSecondLayer = true
    const next = await loadGuestQuerySource({
      client: client().db,
      scope: nextScope,
      readPath: change === 'path' ? 'DARK' : 'LEGACY',
    })
    expect(next.version).not.toBe(first.version)
  })
  const module = {
    moduleId: 'item-1',
    revisionId: 'revision-1',
    kind: 'ITEM' as const,
    version: 1,
    publicationId: 'publication-1',
    publicationOrder: '1',
    audience: 'PUBLIC' as const,
    effectiveFrom: null,
    effectiveUntil: null,
    evidence: [
      {
        sourceId: 'source-1',
        locator: null,
        capturedAt: '2026-10-20T00:00:00.000Z',
        excerptHash: null,
      },
    ],
    payload: {
      kind: 'ITEM' as const,
      name: 'Sketch kit',
      description: null,
      placeId: null,
      itemType: 'PRODUCT',
    },
  }
  it.each(['publicationId', 'publicationOrder', 'evidence', 'payload', 'withdrawal'])(
    'binds canonical %s',
    async (change) => {
      loadModules.mockResolvedValueOnce([module])
      const a = await loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' })
      const m = structuredClone(module)
      if (change === 'publicationId') m.publicationId = 'publication-2'
      if (change === 'publicationOrder') m.publicationOrder = '2'
      if (change === 'evidence') m.evidence[0]!.capturedAt = '2026-10-20T01:00:00Z'
      if (change === 'payload') m.payload.name = 'Field kit'
      loadModules.mockResolvedValueOnce(change === 'withdrawal' ? [] : [m])
      const b = await loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' })
      expect(a.version).not.toBe(b.version)
    },
  )
  it.each(['moduleId', 'revisionId', 'publicationId'] as const)(
    'rejects duplicate canonical %s before directory',
    async (field) => {
      loadModules.mockResolvedValueOnce([
        module,
        {
          ...module,
          moduleId: 'item-2',
          revisionId: 'revision-2',
          publicationId: 'publication-2',
          [field]: module[field],
        },
      ])
      await expect(
        loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' }),
      ).rejects.toThrow('Duplicate canonical')
      expect(loadDirectory).not.toHaveBeenCalled()
    },
  )
  it.each([
    { ...scope, tenantId: '' },
    { ...scope, venueId: ' ' },
    { ...scope, includeSecondLayer: 'false' },
    { ...scope, asOf: new Date('invalid') },
    { ...scope, asOf: '2026-10-21' },
  ])('rejects invalid scope %#', async (invalid) => {
    const c = client()
    await expect(
      loadGuestQuerySource({ client: c.db, scope: invalid as never, readPath: 'LEGACY' }),
    ).rejects.toThrow('Invalid guest query source scope')
    expect(c.transaction).not.toHaveBeenCalled()
  })
})
