import { beforeEach, describe, expect, it, vi } from 'vitest'
import { guestDirectoryVersion } from './guest-directory-index-loader'
import { loadGuestVenueDirectory, type GuestVenueDirectory } from './guest-venue-directory'
import { loadGuestQuerySource, type GuestQueryTransactionClient } from './guest-query-source'

vi.mock('./guest-directory-index-loader', () => ({ guestDirectoryVersion: vi.fn() }))
vi.mock('./guest-venue-directory', () => ({ loadGuestVenueDirectory: vi.fn() }))

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
  const reader = { marker: 'scoped-transaction-reader' }
  const transaction = vi.fn(async (read: (value: unknown) => Promise<unknown>) => read(reader))
  return { reader, transaction, db: { $transaction: transaction } as GuestQueryTransactionClient }
}
const loadDirectory = vi.mocked(loadGuestVenueDirectory)
const loadVersion = vi.mocked(guestDirectoryVersion)
beforeEach(() => {
  vi.resetAllMocks()
  loadDirectory.mockResolvedValue(directory())
  loadVersion.mockResolvedValue('metadata-version-1')
})

describe('complete guest query source', () => {
  it.each(['LEGACY', 'DARK'] as const)(
    'uses one scoped repeatable-read transaction for %s',
    async (readPath) => {
      const { db, reader, transaction } = client()
      const result = await loadGuestQuerySource({ client: db, scope, readPath })
      expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
        isolationLevel: 'RepeatableRead',
        timeout: 15_000,
      })
      const expected = { ...scope, reader }
      expect(loadDirectory).toHaveBeenCalledExactlyOnceWith(expected)
      expect(loadVersion).toHaveBeenCalledExactlyOnceWith(expected)
      expect(loadDirectory.mock.calls[0]![0].reader).toBe(reader)
      expect(loadVersion.mock.calls[0]![0].reader).toBe(reader)
      expect(loadDirectory.mock.invocationCallOrder[0]).toBeLessThan(
        loadVersion.mock.invocationCallOrder[0]!,
      )
      expect(result).toMatchObject({
        ...scope,
        asOf: scope.asOf.toISOString(),
        readPath,
        coverage: 'COMPLETE',
      })
      expect(result.version).toMatch(/^[a-f0-9]{64}$/)
      expect(result.directory.searchVersion).toBe(result.version)
    },
  )

  it('rejects unsupported repeatable read without falling back or reading outside the transaction', async () => {
    const { db, transaction } = client()
    transaction.mockRejectedValueOnce(new Error('isolation unavailable'))
    await expect(loadGuestQuerySource({ client: db, scope, readPath: 'LEGACY' })).rejects.toThrow(
      'isolation unavailable',
    )
    expect(transaction).toHaveBeenCalledOnce()
    expect(loadDirectory).not.toHaveBeenCalled()
    expect(loadVersion).not.toHaveBeenCalled()
  })

  it('rejects NATIVE before reading legacy content', async () => {
    const { db, transaction } = client()
    await expect(
      loadGuestQuerySource({ client: db, scope, readPath: 'NATIVE' as never }),
    ).rejects.toThrow('admitted native snapshot')
    expect(transaction).not.toHaveBeenCalled()
  })

  it.each(['places', 'knowledge'] as const)(
    'rejects duplicate identities within %s',
    async (kind) => {
      const rows = directory()
      if (kind === 'places') rows.places.push({ ...rows.places[0]! })
      else rows.knowledge.push({ ...rows.knowledge[0]! })
      loadDirectory.mockResolvedValueOnce(rows)
      await expect(
        loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' }),
      ).rejects.toThrow('Duplicate guest query source identity')
    },
  )

  it('allows the same ID in different record kinds', async () => {
    const result = await loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' })
    expect(result.directory.places[0]!.id).toBe(result.directory.knowledge[0]!.id)
  })

  it('rejects incomplete membership before asking for a version', async () => {
    loadDirectory.mockResolvedValueOnce({ ...directory(), incomplete: true })
    await expect(
      loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' }),
    ).rejects.toThrow('Incomplete guest query source')
    expect(loadVersion).not.toHaveBeenCalled()
  })

  it.each(['directory', 'version'])(
    'rejects a failed %s read with no fallback or retry',
    async (stage) => {
      if (stage === 'directory') loadDirectory.mockRejectedValueOnce(new Error('read failed'))
      else loadVersion.mockRejectedValueOnce(new Error('read failed'))
      const { db, transaction } = client()
      await expect(loadGuestQuerySource({ client: db, scope, readPath: 'LEGACY' })).rejects.toThrow(
        'read failed',
      )
      expect(transaction).toHaveBeenCalledOnce()
      expect(loadDirectory).toHaveBeenCalledOnce()
      expect(loadVersion).toHaveBeenCalledTimes(stage === 'directory' ? 0 : 1)
    },
  )

  it('keeps the version stable for identical content at a later asOf', async () => {
    const first = await loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' })
    const later = await loadGuestQuerySource({
      client: client().db,
      scope: { ...scope, asOf: new Date('2026-10-21T05:01:00.000Z') },
      readPath: 'LEGACY',
    })
    expect(later.version).toBe(first.version)
    expect(later.asOf).not.toBe(first.asOf)
  })

  it.each(['body', 'membership', 'metadata', 'tenant', 'venue', 'audience', 'path'])(
    'binds version to %s',
    async (change) => {
      const first = await loadGuestQuerySource({ client: client().db, scope, readPath: 'LEGACY' })
      const nextScope = { ...scope }
      if (change === 'body' || change === 'membership') {
        const rows = directory()
        if (change === 'body') rows.knowledge[0]!.content = 'Admission is free.'
        else rows.knowledge = []
        loadDirectory.mockResolvedValueOnce(rows)
      }
      if (change === 'metadata') loadVersion.mockResolvedValueOnce('metadata-version-2')
      if (change === 'tenant') nextScope.tenantId = 'other-tenant'
      if (change === 'venue') nextScope.venueId = 'other-venue'
      if (change === 'audience') nextScope.includeSecondLayer = true
      const next = await loadGuestQuerySource({
        client: client().db,
        scope: nextScope,
        readPath: change === 'path' ? 'DARK' : 'LEGACY',
      })
      expect(next.version).not.toBe(first.version)
    },
  )

  it.each([
    { ...scope, tenantId: '' },
    { ...scope, venueId: '  ' },
    { ...scope, includeSecondLayer: 'false' },
    { ...scope, asOf: new Date('invalid') },
    { ...scope, asOf: '2026-10-21T05:00:00.000Z' },
  ])('rejects invalid scope before transaction %#', async (invalid) => {
    const { db, transaction } = client()
    await expect(
      loadGuestQuerySource({ client: db, scope: invalid as never, readPath: 'LEGACY' }),
    ).rejects.toThrow('Invalid guest query source scope')
    expect(transaction).not.toHaveBeenCalled()
  })
})
