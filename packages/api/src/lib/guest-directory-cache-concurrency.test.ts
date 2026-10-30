import { describe, expect, it } from 'vitest'

import { createVersionedGuestDirectoryCache } from './guest-directory-index-loader'
import type { GuestVenueDirectory } from './guest-venue-directory'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const empty = (): GuestVenueDirectory => ({ knowledge: [], places: [], incomplete: false })
function params(reader: unknown, venueId = 'venue') {
  return {
    reader,
    tenantId: 'tenant',
    venueId,
    includeSecondLayer: false,
    asOf: new Date('2026-10-20T12:00:00Z'),
  }
}

describe('versioned directory concurrent misses', () => {
  it('accounts exactly once for concurrent same-scope inserts and can evict afterward', async () => {
    const reader = {
      venueKnowledgeEntry: { findMany: async () => [] },
      place: { findMany: async () => [] },
    }
    const cache = createVersionedGuestDirectoryCache({ maxEntries: 1 })
    const firstBody = deferred<GuestVenueDirectory>()
    const secondBody = deferred<GuestVenueDirectory>()
    const bothStarted = deferred<void>()
    let starts = 0
    const load = () => {
      starts++
      if (starts === 2) bothStarted.resolve()
      return starts === 1 ? firstBody.promise : secondBody.promise
    }
    const first = cache.get(params(reader), load)
    const second = cache.get(params(reader), load)
    await bothStarted.promise
    firstBody.resolve(empty())
    const a = await first
    secondBody.resolve(empty())
    const b = await second
    expect(cache.stats()).toEqual({ entries: 1, bytes: JSON.stringify(b).length * 2 })
    expect(a.searchVersion).toBe(b.searchVersion)
    const other = await cache.get(params(reader, 'other-venue'), async () => empty())
    expect(cache.stats()).toEqual({ entries: 1, bytes: JSON.stringify(other).length * 2 })
  })

  it('does not let an older metadata snapshot replace a completed newer request', async () => {
    let stamp = new Date('2026-10-01')
    let metadataReads = 0
    const oldAfterStarted = deferred<void>()
    const releaseOldAfter = deferred<void>()
    const reader = {
      venueKnowledgeEntry: {
        findMany: async () => {
          const captured = stamp
          metadataReads++
          if (metadataReads === 2) {
            oldAfterStarted.resolve()
            await releaseOldAfter.promise
          }
          return [{ id: 'topic', updatedAt: captured, sourceType: 'MANUAL', contentModuleId: null }]
        },
      },
      place: { findMany: async () => [] },
    }
    const cache = createVersionedGuestDirectoryCache()
    const old = cache.get(params(reader), async () => empty())
    await oldAfterStarted.promise
    stamp = new Date('2026-10-02')
    const newer = await cache.get(params(reader), async () => empty())
    releaseOldAfter.resolve()
    const older = await old
    expect(older.searchVersion).not.toBe(newer.searchVersion)
    const hit = await cache.get(params(reader), async () => {
      throw new Error('Newer version was replaced')
    })
    expect(hit).toBe(newer)
    expect(cache.stats()).toEqual({ entries: 1, bytes: JSON.stringify(newer).length * 2 })
  })
})
