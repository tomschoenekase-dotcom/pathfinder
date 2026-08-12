import { describe, expect, it, vi } from 'vitest'
import { buildVenueContentSnapshot, createVenueContentSnapshot } from './venue-content-snapshot'

const base = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  venue: { id: 'venue-1', name: 'Caf\u00e9' },
  places: [
    { id: 'p2', name: 'B' },
    { id: 'p1', name: 'A' },
  ],
  knowledgeEntries: [],
  operationalUpdates: [],
  universalRevisions: [],
}
describe('venue content snapshot', () => {
  it('is stable across component ordering and NFC-equivalent text', () => {
    const a = buildVenueContentSnapshot(base)
    const b = buildVenueContentSnapshot({
      ...base,
      venue: { id: 'venue-1', name: 'Cafe\u0301' },
      places: [...base.places].reverse(),
    })
    expect(a.hash).toBe(b.hash)
  })
  it('changes for one guest-facing field', () => {
    expect(buildVenueContentSnapshot(base).hash).not.toBe(
      buildVenueContentSnapshot({ ...base, venue: { ...base.venue, name: 'Other' } }).hash,
    )
  })
  it('changes when published event timing changes', () => {
    const eventRevision = {
      id: 'revision-1',
      moduleId: 'module-1',
      kind: 'EVENT',
      version: 1,
      audience: 'PUBLIC',
      event: {
        name: 'Tour',
        description: 'A guided tour',
        placeId: null,
        startsAt: '2026-08-11T18:00:00.000Z',
        endsAt: null,
      },
    }
    expect(
      buildVenueContentSnapshot({ ...base, universalRevisions: [eventRevision] }).hash,
    ).not.toBe(
      buildVenueContentSnapshot({
        ...base,
        universalRevisions: [
          {
            ...eventRevision,
            event: { ...eventRevision.event, startsAt: '2026-08-11T19:00:00.000Z' },
          },
        ],
      }).hash,
    )
  })
  it('binds tenant and venue to prevent cross-venue reuse', () => {
    expect(buildVenueContentSnapshot(base).hash).not.toBe(
      buildVenueContentSnapshot({ ...base, venueId: 'venue-2' }).hash,
    )
  })
  it('queries only explicit publication events in the exact tenant and venue scope', async () => {
    const contentModulePublication = { findMany: vi.fn().mockResolvedValue([]) }
    const scopedEmpty = { findMany: vi.fn().mockResolvedValue([]) }
    const client = {
      venue: { findFirst: vi.fn().mockResolvedValue(base.venue) },
      place: scopedEmpty,
      venueKnowledgeEntry: { findMany: vi.fn().mockResolvedValue([]) },
      operationalUpdate: { findMany: vi.fn().mockResolvedValue([]) },
      contentModulePublication,
      contentVersion: { aggregate: vi.fn().mockResolvedValue({ _max: { sequence: null } }) },
    }
    const result = await createVenueContentSnapshot({
      db: client as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      asOf: new Date('2026-08-11T12:00:00Z'),
    })
    expect(contentModulePublication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
        }),
        take: 501,
      }),
    )
    expect(contentModulePublication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          revision: {
            select: expect.objectContaining({
              event: {
                select: expect.objectContaining({ startsAt: true, endsAt: true }),
              },
            }),
          },
        }),
      }),
    )
    expect(JSON.stringify(result.manifest)).not.toContain('internal secret')
  })
})
