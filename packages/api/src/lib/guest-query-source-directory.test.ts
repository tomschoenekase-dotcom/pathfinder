import { describe, expect, it, vi } from 'vitest'
import type { EffectivePublishedUniversalContentSnapshot } from '@pathfinder/db'
import { loadGuestQuerySourceDirectory } from './guest-query-source-directory'
import { loadGuestVenueDirectory } from './guest-venue-directory'
import { guestKnowledgeScope } from './guest-knowledge-retrieval'
import { guestPlaceScope } from './guest-directory-index-loader'
const scope = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  includeSecondLayer: false,
  asOf: new Date('2026-10-21T05:00:00Z'),
}
const module = (id = 'module-a') =>
  ({
    moduleId: id,
    revisionId: 'revision-' + id,
    publicationId: 'publication-' + id,
    publicationOrder: '1',
    kind: 'SERVICE',
    version: 1,
    audience: 'PUBLIC',
    effectiveFrom: null,
    effectiveUntil: null,
    evidence: [],
    payload: {
      kind: 'SERVICE',
      name: 'Whole service',
      description: 'Booking required. No refunds.',
      availability: 'Weekends only.',
      placeId: 'place-a',
    },
  }) as EffectivePublishedUniversalContentSnapshot
function topic(id = 'topic-a', bound = true) {
  const m = module()
  return {
    id,
    title: 'Whole service',
    category: 'SERVICE',
    content: 'Booking required. No refunds.\nWeekends only.',
    sourceType: 'UNIVERSAL_CONTENT',
    sourceName: null,
    sourceUrl: null,
    updatedAt: new Date('2026-10-20T00:00:00Z'),
    lastReviewedAt: null,
    contentModuleId: bound ? m.moduleId : null,
    contentRevisionId: bound ? m.revisionId : null,
    contentPublicationId: bound ? m.publicationId : null,
    contentRevision: bound
      ? { createdBy: 'operator', effectiveFrom: null, effectiveUntil: null, operationalFact: null }
      : null,
    contentPublication: bound
      ? { eventOrder: 1n, module: { publications: [{ id: m.publicationId, eventOrder: 1n }] } }
      : null,
  }
}
const place = () => ({
  id: 'place-a',
  name: 'Fictional counter',
  type: 'SHOP',
  itemType: null,
  shortDescription: null,
  longDescription: 'Whole place condition.',
  lat: null,
  lng: null,
  tags: [],
  areaName: null,
  hours: null,
  photoUrl: null,
  sourceType: 'MANUAL',
  sourceName: null,
  sourceUrl: null,
  updatedAt: new Date('2026-10-20T00:00:00Z'),
})
type PageArgs = { where: { id?: { gt: string } }; select: Record<string, unknown>; take: number }
function reader(rows = [topic()], places = [place()], activated: string[] = []) {
  const page = (values: Array<{ id: string } & Record<string, unknown>>, args: PageArgs) =>
    values
      .filter((x) => !args.where.id || x.id > args.where.id.gt)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, args.take)
      .map((x) =>
        Object.fromEntries(
          Object.keys(args.select)
            .filter((k) => k in x)
            .map((k) => [k, x[k]]),
        ),
      )
  return {
    venueKnowledgeEntry: { findMany: vi.fn(async (args: PageArgs) => page(rows, args)) },
    place: { findMany: vi.fn(async (args: PageArgs) => page(places, args)) },
    legacyKnowledgeAdoptionActivation: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        expect(args).toMatchObject({ where: { tenantId: scope.tenantId, venueId: scope.venueId } })
        return activated.map((id) => ({ adoption: { legacyKnowledgeEntryId: id } }))
      }),
    },
  }
}
const load = (r: ReturnType<typeof reader>, modules = [module()], s = scope) =>
  loadGuestQuerySourceDirectory({ ...s, reader: r, modules })
describe('one-read structured source directory authority', () => {
  it('matches legacy whole directory for valid current rows while eliminating deep head selection', async () => {
    const r = reader()
    const old = await loadGuestVenueDirectory({ ...scope, reader: r })
    r.venueKnowledgeEntry.findMany.mockClear()
    r.place.findMany.mockClear()
    r.legacyKnowledgeAdoptionActivation.findMany.mockClear()
    const result = await load(r)
    expect(result.directory).toEqual(old)
    expect(r.venueKnowledgeEntry.findMany).toHaveBeenCalledOnce()
    expect(r.place.findMany).toHaveBeenCalledOnce()
    expect(r.legacyKnowledgeAdoptionActivation.findMany).toHaveBeenCalledOnce()
    const args = r.venueKnowledgeEntry.findMany.mock.calls[0]![0]
    expect(args.where).toEqual(guestKnowledgeScope(scope))
    expect(args.select.contentPublication).toBeUndefined()
    expect(args.select.contentRevision).toEqual({ select: { createdBy: true } })
    expect(args.take).toBe(500)
    expect(result.authority.places[0]!.updatedAt).toEqual(place().updatedAt)
    expect(result.directory.places[0]).not.toHaveProperty('updatedAt')
  })
  it.each([false, true])('retains exact second-layer SQL scope %s', async (includeSecondLayer) => {
    const r = reader()
    const s = { ...scope, includeSecondLayer }
    await load(r, [module()], s)
    expect(r.venueKnowledgeEntry.findMany.mock.calls[0]![0].where).toEqual(guestKnowledgeScope(s))
    expect(r.place.findMany.mock.calls[0]![0].where).toEqual(guestPlaceScope(s))
    expect(r.legacyKnowledgeAdoptionActivation.findMany.mock.calls[0]![0]).toEqual({
      where: { tenantId: s.tenantId, venueId: s.venueId },
      select: { adoption: { select: { legacyKnowledgeEntryId: true } } },
    })
  })
  it.each(['contentModuleId', 'contentRevisionId', 'contentPublicationId'] as const)(
    'excludes wrong current %s without promoting stale bytes',
    async (field) => {
      const row = topic()
      row[field] = 'wrong'
      const result = await load(reader([row]))
      expect(result.directory.knowledge).toEqual([])
      expect(result.authority.knowledge[0]!.admitted).toBe(false)
    },
  )
  it.each(['withdrawn', 'private', 'future', 'ended', 'expired operational fact'])(
    'excludes a bound alias absent from admitted snapshot: %s',
    async () => {
      const result = await load(reader(), [])
      expect(result.directory.knowledge).toEqual([])
      expect(result.authority.knowledge[0]!.admitted).toBe(false)
    },
  )
  it.each(['SOURCE_CONNECTION', 'created-by-prefix'])(
    'rejects connected source despite an exact triple: %s',
    async (reason) => {
      const row = topic()
      if (reason === 'SOURCE_CONNECTION') row.sourceType = 'SOURCE_CONNECTION'
      else row.contentRevision!.createdBy = 'source-connection:synthetic'
      expect((await load(reader([row]))).directory.knowledge).toEqual([])
    },
  )
  it('rejects connected creator on an unbound row as legacy does', async () => {
    const row = topic('unbound', false)
    row.contentRevision = {
      createdBy: 'source-connection:synthetic',
      effectiveFrom: null,
      effectiveUntil: null,
      operationalFact: null,
    }
    expect((await load(reader([row]), [])).directory.knowledge).toEqual([])
  })
  it.each(['MANUAL', 'UNIVERSAL_CONTENT', 'IMPORTED'])(
    'retains unbound %s whole text',
    async (sourceType) => {
      const row = topic('manual', false)
      row.sourceType = sourceType
      const result = await load(reader([row]), [])
      expect(result.directory.knowledge[0]!.content).toBe(row.content)
      expect(result.directory.knowledge[0]!.contentModuleId).toBeNull()
    },
  )
  it('retains older fixtures with all binding fields omitted', async () => {
    const row = topic('manual', false)
    Reflect.deleteProperty(row, 'contentModuleId')
    Reflect.deleteProperty(row, 'contentRevisionId')
    Reflect.deleteProperty(row, 'contentPublicationId')
    const result = await load(reader([row]), [])
    expect(result.directory.knowledge).toHaveLength(1)
    expect(result.directory.knowledge[0]).not.toHaveProperty('contentModuleId')
  })
  it.each([1, 2, 3, 4, 5, 6])(
    'rejects partial migration binding mask %i rather than silently omitting a condition',
    async (mask) => {
      const row = topic()
      ;(['contentModuleId', 'contentRevisionId', 'contentPublicationId'] as const).forEach(
        (field, index) => {
          if (!(mask & (1 << index))) row[field] = null
        },
      )
      await expect(load(reader([row]))).rejects.toThrow(
        'Inconsistent Knowledge publication binding',
      )
    },
  )
  it.each(['contentModuleId', 'contentRevisionId', 'contentPublicationId'] as const)(
    'rejects empty %s',
    async (field) => {
      const row = topic()
      row[field] = ' '
      await expect(load(reader([row]))).rejects.toThrow(
        'Inconsistent Knowledge publication binding',
      )
    },
  )
  it('excludes adopted legacy rows and binds even currently hidden activation IDs', async () => {
    const r = reader([topic('legacy', false), topic('visible', false)], [], ['legacy', 'hidden'])
    const result = await load(r, [])
    expect(result.directory.knowledge.map((x) => x.id)).toEqual(['visible'])
    expect(result.authority.activatedLegacyIds).toEqual(['hidden', 'legacy'])
  })
  it('retains all admitted kinds even when structured compiler does not attach their bodies', async () => {
    for (const kind of ['ITEM', 'SERVICE', 'POLICY', 'EVENT', 'OPERATIONAL_FACT'] as const) {
      const m = { ...module(), kind } as EffectivePublishedUniversalContentSnapshot
      const result = await load(reader(), [m])
      expect(result.directory.knowledge).toHaveLength(1)
    }
  })
  it('pages 1001 exact aliases once, including after the former400 boundary', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) =>
      topic('topic-' + String(i).padStart(4, '0')),
    )
    const r = reader(rows)
    const result = await load(r)
    expect(result.directory.knowledge).toHaveLength(1001)
    expect(r.venueKnowledgeEntry.findMany).toHaveBeenCalledTimes(3)
    expect(r.venueKnowledgeEntry.findMany.mock.calls.map(([a]) => a.where.id?.gt)).toEqual([
      undefined,
      'topic-0499',
      'topic-0999',
    ])
  })
  it('propagates page failure without partial membership', async () => {
    const r = reader()
    r.venueKnowledgeEntry.findMany.mockRejectedValueOnce(Error('page failed'))
    await expect(load(r)).rejects.toThrow('page failed')
  })
  it('supports empty authoritative source without synthetic fallback', async () => {
    const result = await load(reader([], []), [])
    expect(result.directory).toEqual({ knowledge: [], places: [], incomplete: false })
    expect(result.authority).toEqual({ knowledge: [], places: [], activatedLegacyIds: [] })
  })
  it('binds metadata that affects authority while leaving body bytes intact', async () => {
    const r = reader()
    const a = await load(r)
    const row = topic()
    row.updatedAt = new Date('2026-10-21T01:00:00Z')
    row.contentRevision!.createdBy = 'other-operator'
    const p = place()
    p.updatedAt = new Date('2026-10-21T01:00:00Z')
    const b = await load(reader([row], [p]))
    expect(a.directory.knowledge[0]!.content).toBe(b.directory.knowledge[0]!.content)
    expect(a.authority).not.toEqual(b.authority)
    expect(a.directory.places).toEqual(b.directory.places)
  })
})
