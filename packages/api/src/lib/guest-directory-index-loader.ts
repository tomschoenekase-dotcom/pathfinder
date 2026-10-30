import { createHash } from 'node:crypto'

import {
  guestKnowledgeScope,
  guestKnowledgeSelectShape,
  type GuestKnowledgeReader,
} from './guest-knowledge-retrieval'
import type {
  GuestDirectoryPlace,
  GuestVenueDirectory,
  loadGuestVenueDirectory,
} from './guest-venue-directory'

const PAGE_SIZE = 500
const MAX_CACHED_VENUE_BYTES = 32 * 1024 * 1024
const MAX_CACHE_BYTES = 128 * 1024 * 1024
const MAX_CACHE_ENTRIES = 32

type Scope = Parameters<typeof loadGuestVenueDirectory>[0]
type Page = {
  where: { id?: { gt: string } }
  args: { orderBy: Array<{ id: 'asc' }>; take: number }
}

/** Scope is repeated on every ID-keyset page. Failure never returns a partial directory. */
export async function pageGuestRows<T extends { id: string }>(
  load: (page: Page) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  let after: string | undefined
  for (;;) {
    const page = await load({
      where: after === undefined ? {} : { id: { gt: after } },
      args: { orderBy: [{ id: 'asc' }], take: PAGE_SIZE },
    })
    if (page.length > PAGE_SIZE) throw new Error('Guest directory page exceeded its bound')
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
    const next = page[page.length - 1]!.id
    if (after !== undefined && next <= after)
      throw new Error('Guest directory paging did not advance')
    after = next
  }
}

export function guestPlaceScope(scope: Pick<Scope, 'tenantId' | 'venueId' | 'includeSecondLayer'>) {
  return {
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    isActive: true,
    ...(scope.includeSecondLayer ? {} : { visibility: 'PUBLIC' }),
  }
}

export const guestPlaceSelect = {
  id: true,
  name: true,
  type: true,
  itemType: true,
  shortDescription: true,
  longDescription: true,
  lat: true,
  lng: true,
  tags: true,
  areaName: true,
  hours: true,
  photoUrl: true,
  sourceType: true,
  sourceName: true,
  sourceUrl: true,
}

/** Narrow metadata, including latest publication identity even when the compatibility row is unchanged. */
export async function guestDirectoryVersion(params: Scope): Promise<string> {
  const reader = params.reader as GuestKnowledgeReader & {
    place: {
      findMany(
        args: Record<string, unknown>,
      ): Promise<Array<GuestDirectoryPlace & { updatedAt?: Date }>>
    }
  }
  const full = guestKnowledgeSelectShape()
  const [knowledge, places, activated] = await Promise.all([
    pageGuestRows((page) =>
      reader.venueKnowledgeEntry.findMany({
        where: { ...guestKnowledgeScope(params), ...page.where },
        select: {
          id: true,
          updatedAt: true,
          sourceType: true,
          contentModuleId: true,
          contentRevisionId: true,
          contentPublicationId: true,
          contentRevision: full.contentRevision,
          contentPublication: full.contentPublication,
        },
        ...page.args,
      }),
    ),
    pageGuestRows((page) =>
      reader.place.findMany({
        where: { ...guestPlaceScope(params), ...page.where },
        select: { id: true, updatedAt: true },
        ...page.args,
      }),
    ),
    reader.legacyKnowledgeAdoptionActivation
      ? reader.legacyKnowledgeAdoptionActivation.findMany({
          where: { tenantId: params.tenantId, venueId: params.venueId },
          select: { adoption: { select: { legacyKnowledgeEntryId: true } } },
        })
      : Promise.resolve([]),
  ])
  const hash = createHash('sha256')
  hash.update(JSON.stringify([params.tenantId, params.venueId, params.includeSecondLayer]))
  // Explicit field projection also makes the version independent of mock readers returning extra fields.
  for (const row of knowledge)
    hash.update(
      JSON.stringify(
        [
          row.id,
          row.updatedAt,
          row.sourceType,
          row.contentModuleId,
          row.contentRevisionId,
          row.contentPublicationId,
          row.contentRevision,
          row.contentPublication,
        ],
        (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      ),
    )
  for (const row of places) hash.update(JSON.stringify([row.id, row.updatedAt]))
  hash.update(JSON.stringify(activated.map((row) => row.adoption.legacyKnowledgeEntryId).sort()))
  return hash.digest('hex')
}

type CacheEntry = {
  requestId: number
  version: string
  directory: GuestVenueDirectory
  bytes: number
}

/** Byte- and venue-bounded LRU. A metadata read failure never serves a previously cached guide. */
export function createVersionedGuestDirectoryCache(
  options: { maxVenueBytes?: number; maxBytes?: number; maxEntries?: number } = {},
) {
  const entries = new Map<string, CacheEntry>()
  let bytes = 0
  let requestSequence = 0
  const drop = (key: string) => {
    const entry = entries.get(key)
    if (entry) bytes -= entry.bytes
    entries.delete(key)
  }
  return {
    async get(
      params: Scope,
      load: () => Promise<GuestVenueDirectory>,
    ): Promise<GuestVenueDirectory> {
      const requestId = ++requestSequence
      const key = JSON.stringify([params.tenantId, params.venueId, params.includeSecondLayer])
      const version = await guestDirectoryVersion(params)
      const hit = entries.get(key)
      if (hit?.version === version) {
        entries.delete(key)
        entries.set(key, hit)
        return hit.directory
      }
      const directory = await load()
      // Metadata may have changed during the body read. Never bind bodies to an unrelated version.
      const after = await guestDirectoryVersion(params)
      if (after !== version) return load()
      const value = { ...directory, searchVersion: `${key}:${version}` }
      const size = JSON.stringify(value).length * 2
      if (
        size <= (options.maxVenueBytes ?? MAX_CACHED_VENUE_BYTES) &&
        (entries.get(key)?.requestId ?? 0) <= requestId
      ) {
        // Another miss may have completed while this request awaited its body/metadata reads.
        // Account for the actual prior entry at insertion, and never replace a newer request.
        drop(key)
        entries.set(key, { requestId, version, directory: value, bytes: size })
        bytes += size
        while (
          bytes > (options.maxBytes ?? MAX_CACHE_BYTES) ||
          entries.size > (options.maxEntries ?? MAX_CACHE_ENTRIES)
        )
          drop(entries.keys().next().value!)
      }
      return value
    },
    clear() {
      entries.clear()
      bytes = 0
    },
    stats() {
      return { entries: entries.size, bytes }
    },
  }
}

// Test suites supply independent mock DB instances; never share their content across tests.
const shared = createVersionedGuestDirectoryCache()
export function loadVersionedGuestDirectory(
  params: Scope,
  load: () => Promise<GuestVenueDirectory>,
) {
  return (process.env.NODE_ENV === 'test' ? createVersionedGuestDirectoryCache() : shared).get(
    params,
    load,
  )
}
