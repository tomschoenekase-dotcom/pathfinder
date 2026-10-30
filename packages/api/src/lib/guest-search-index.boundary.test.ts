import { describe, expect, it, vi } from 'vitest'
import { createVersionedGuestDirectoryCache } from './guest-directory-index-loader'
import { loadGuestVenueDirectory } from './guest-venue-directory'

type Row = Record<string, unknown> & { id: string }
const stamp = new Date('2026-10-01T00:00:00Z')
const scope = { tenantId: 't-one', venueId: 'v-one', includeSecondLayer: false, asOf: new Date('2026-10-20T12:00:00Z') }
function topic(id: string, extra: Record<string, unknown> = {}): Row {
  return { id, tenantId: scope.tenantId, venueId: scope.venueId, isEnabled: true, visibility: 'PUBLIC', title: `Topic ${id}`, category: 'POLICIES', content: `Independent body ${id}`, sourceType: 'MANUAL', sourceName: null, sourceUrl: null, updatedAt: stamp, lastReviewedAt: null, contentModuleId: null, contentRevisionId: null, contentPublicationId: null, contentRevision: null, contentPublication: null, universalContentAdoption: null, ...extra }
}
function place(id: string, extra: Record<string, unknown> = {}): Row {
  return { id, tenantId: scope.tenantId, venueId: scope.venueId, isActive: true, visibility: 'PUBLIC', name: `Place ${id}`, type: 'OTHER', itemType: null, shortDescription: 'A synthetic stop.', longDescription: null, lat: 0, lng: 0, tags: [], areaName: null, hours: null, photoUrl: null, sourceType: 'MANUAL', sourceName: null, sourceUrl: null, updatedAt: stamp, ...extra }
}
// A small generic query interpreter: fixtures are filtered by the supplied predicates, not by
// a separately hard-coded version of the product's intended visibility rules.
function matches(value: unknown, predicate: unknown): boolean {
  if (predicate === null) return value == null
  if (typeof predicate !== 'object' || predicate instanceof Date) return value === predicate
  const obj = predicate as Record<string, unknown>
  return Object.entries(obj).every(([key, expected]) => {
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every((p) => matches(value, p))
    if (key === 'OR') return (expected as unknown[]).some((p) => matches(value, p))
    if (key === 'NOT' || key === 'not') return !matches(value, expected)
    if (key === 'is') return matches(value, expected)
    if (key === 'gt') return (value as string) > (expected as string)
    if (key === 'lte') return (value as Date) <= (expected as Date)
    if (key === 'startsWith') return typeof value === 'string' && value.startsWith(expected as string)
    return matches((value as Record<string, unknown> | null)?.[key], expected)
  })
}
function database(initialTopics: Row[] = [], initialPlaces: Row[] = []) {
  const state = { topics: initialTopics, places: initialPlaces, adopted: [] as string[], failAfter: undefined as string | undefined }
  const read = (kind: 'topics' | 'places') => vi.fn(async (args: Record<string, unknown>) => {
    const where = args.where as Record<string, unknown>
    const after = (where.id as { gt?: string } | undefined)?.gt
    if (state.failAfter && after === state.failAfter) throw new Error('synthetic page failure')
    return state[kind].filter((r) => matches(r, where)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, args.take as number)
  })
  const reader = { venueKnowledgeEntry: { findMany: read('topics') }, place: { findMany: read('places') }, legacyKnowledgeAdoptionActivation: { findMany: vi.fn(async () => state.adopted.map((id) => ({ adoption: { legacyKnowledgeEntryId: id } }))) } }
  return { state, reader, params: { ...scope, reader } }
}
function published(id: string): Row {
  return topic(id, { contentModuleId: 'module', contentRevisionId: 'revision', contentPublicationId: 'pub', contentRevision: { audience: 'PUBLIC', kind: 'ARTICLE', effectiveFrom: null, effectiveUntil: null, operationalFact: null, createdBy: 'operator' }, contentPublication: { action: 'PUBLISH', eventOrder: 1n, module: { publications: [{ id: 'pub', eventOrder: 1n }] } } })
}

describe('guest all-record index independent boundaries', () => {
  it.each([500, 501, 1000])('loads all %i topics and places, including exact page endings', async (count) => {
    const ids = Array.from({ length: count }, (_, i) => `r${String(i).padStart(5, '0')}`)
    const db = database(ids.map((id) => topic(id)), ids.map((id) => place(id)))
    const result = await loadGuestVenueDirectory(db.params)
    expect(result.incomplete).toBe(false)
    expect(new Set(result.knowledge.map((r) => r.id))).toEqual(new Set(ids))
    expect(new Set(result.places.map((r) => r.id))).toEqual(new Set(ids))
    expect(db.reader.venueKnowledgeEntry.findMany.mock.calls.length).toBeGreaterThan(1)
    for (const [args] of [...db.reader.venueKnowledgeEntry.findMany.mock.calls, ...db.reader.place.findMany.mock.calls]) {
      expect(args.where).toMatchObject({ tenantId: scope.tenantId, venueId: scope.venueId })
    }
  })

  it('excludes foreign, disabled, private, connected, adopted and non-authoritative records', async () => {
    const current = published('current')
    const stale = published('stale')
    ;(stale.contentPublication as { module: unknown }).module = { publications: [{ id: 'replacement', eventOrder: 2n }] }
    const future = published('future')
    ;(future.contentRevision as Record<string, unknown>).effectiveFrom = new Date('2027-01-01')
    const expired = published('expired')
    ;(expired.contentRevision as Record<string, unknown>).effectiveUntil = new Date('2026-01-01')
    const withdrawn = published('withdrawn')
    ;(withdrawn.contentPublication as Record<string, unknown>).action = 'UNPUBLISH'
    const privateRevision = published('private-revision')
    ;(privateRevision.contentRevision as Record<string, unknown>).audience = 'PRIVATE'
    const connectedRevision = published('connected-revision')
    ;(connectedRevision.contentRevision as Record<string, unknown>).createdBy = 'source-connection:fixture'
    const db = database([topic('safe'), current, stale, future, expired, withdrawn, privateRevision, connectedRevision, topic('tenant', { tenantId: 'other' }), topic('venue', { venueId: 'other' }), topic('disabled', { isEnabled: false }), topic('private', { visibility: 'PRIVATE' }), topic('connected', { sourceType: 'SOURCE_CONNECTION' }), topic('adopted')], [place('safe'), place('tenant', { tenantId: 'other' }), place('venue', { venueId: 'other' }), place('inactive', { isActive: false }), place('private', { visibility: 'PRIVATE' })])
    db.state.adopted = ['adopted']
    const result = await loadGuestVenueDirectory(db.params)
    expect(result.knowledge.map((r) => r.id).sort()).toEqual(['current', 'safe'])
    expect(result.places.map((r) => r.id)).toEqual(['safe'])
  })

  it('rejects a failed later page and retries without retaining a partial complete guide', async () => {
    const db = database(Array.from({ length: 501 }, (_, i) => topic(`r${String(i).padStart(5, '0')}`)))
    const cache = createVersionedGuestDirectoryCache()
    db.state.failAfter = 'r00499'
    await expect(cache.get(db.params, () => loadGuestVenueDirectory(db.params))).rejects.toThrow('synthetic page failure')
    expect(cache.stats().entries).toBe(0)
    db.state.failAfter = undefined
    const result = await cache.get(db.params, () => loadGuestVenueDirectory(db.params))
    expect(result.knowledge).toHaveLength(501)
    expect(result.incomplete).toBe(false)
  })

  it('refreshes cached bodies for edits, additions, removals, adoption and latest publication changes', async () => {
    const db = database([topic('a'), published('published')], [place('p')])
    const cache = createVersionedGuestDirectoryCache()
    const load = vi.fn(() => loadGuestVenueDirectory(db.params))
    const get = () => cache.get(db.params, load)
    const first = await get()
    expect(await get()).toBe(first)
    expect(load).toHaveBeenCalledTimes(1)
    db.state.topics[0] = topic('a', { content: 'Changed policy.', updatedAt: new Date('2026-10-02') })
    expect((await get()).knowledge.find((r) => r.id === 'a')?.content).toBe('Changed policy.')
    db.state.topics.push(topic('b'))
    expect((await get()).knowledge.map((r) => r.id)).toContain('b')
    db.state.topics = db.state.topics.filter((r) => r.id !== 'b')
    expect((await get()).knowledge.map((r) => r.id)).not.toContain('b')
    db.state.places[0] = place('p', { name: 'Renamed stop', updatedAt: new Date('2026-10-03') })
    expect((await get()).places[0]?.name).toBe('Renamed stop')
    db.state.adopted = ['a']
    expect((await get()).knowledge.map((r) => r.id)).not.toContain('a')
    const publication = db.state.topics.find((r) => r.id === 'published')!.contentPublication as { module: unknown }
    publication.module = { publications: [{ id: 'new-unpublish', eventOrder: 2n }] }
    expect((await get()).knowledge.map((r) => r.id)).not.toContain('published')
  })

  it('never caches a failed body load or serves a warm entry after metadata fails', async () => {
    const db = database([topic('safe')])
    const cache = createVersionedGuestDirectoryCache()
    await expect(cache.get(db.params, async () => { throw new Error('body unavailable') })).rejects.toThrow('body unavailable')
    expect(cache.stats().entries).toBe(0)
    const load = vi.fn(() => loadGuestVenueDirectory(db.params))
    await cache.get(db.params, load)
    db.reader.venueKnowledgeEntry.findMany.mockRejectedValueOnce(new Error('metadata unavailable'))
    await expect(cache.get(db.params, load)).rejects.toThrow('metadata unavailable')
  })

  it('separates tenant, venue and second-layer cache authority and evicts least recently used scopes', async () => {
    const db = database([topic('public'), topic('private', { visibility: 'PRIVATE' }), topic('foreign', { tenantId: 't-two' }), topic('other-venue', { venueId: 'v-two' })])
    const cache = createVersionedGuestDirectoryCache({ maxEntries: 3 })
    const get = (extra = {}) => { const params = { ...db.params, ...extra }; return cache.get(params, () => loadGuestVenueDirectory(params)) }
    const a = await get()
    const secondLayer = await get({ includeSecondLayer: true })
    expect(secondLayer.knowledge).toHaveLength(2)
    expect((await get({ tenantId: 't-two' })).knowledge.map((r) => r.id)).toEqual(['foreign'])
    expect(await get()).toBe(a)
    expect((await get({ venueId: 'v-two' })).knowledge.map((r) => r.id)).toEqual(['other-venue'])
    expect(cache.stats().entries).toBe(3)
    expect(await get()).toBe(a)
    const reloaded = await get({ includeSecondLayer: true })
    expect(reloaded.knowledge).toHaveLength(2)
    expect(reloaded).not.toBe(secondLayer)
    expect(cache.stats().entries).toBe(3)
  })

  it('bounds aggregate bytes and declines to retain an oversized venue', async () => {
    const db = database([topic('large', { content: 'large '.repeat(1000) })])
    const cache = createVersionedGuestDirectoryCache({ maxVenueBytes: 100, maxBytes: 200 })
    const load = vi.fn(() => loadGuestVenueDirectory(db.params))
    expect((await cache.get(db.params, load)).knowledge).toHaveLength(1)
    await cache.get(db.params, load)
    expect(load).toHaveBeenCalledTimes(2)
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 })
    const bounded = createVersionedGuestDirectoryCache({ maxBytes: 2000, maxVenueBytes: 2000 })
    db.state.topics = [topic('small')]
    const first = await bounded.get(db.params, () => loadGuestVenueDirectory(db.params))
    for (const venueId of ['one', 'two', 'three']) {
      db.state.topics = [topic('small', { venueId })]
      const params = { ...db.params, venueId }
      await bounded.get(params, () => loadGuestVenueDirectory(params))
      expect(bounded.stats().bytes).toBeLessThanOrEqual(2000)
    }
    db.state.topics = [topic('small')]
    expect(await bounded.get(db.params, () => loadGuestVenueDirectory(db.params))).not.toBe(first)
  })
})
