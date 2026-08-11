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
  it('binds tenant and venue to prevent cross-venue reuse', () => {
    expect(buildVenueContentSnapshot(base).hash).not.toBe(
      buildVenueContentSnapshot({ ...base, venueId: 'venue-2' }).hash,
    )
  })
  it('queries only PUBLIC revisions in the exact tenant and venue scope', async () => {
    const contentModuleRevision = { findMany: vi.fn().mockResolvedValue([]) }
    const scopedEmpty = { findMany: vi.fn().mockResolvedValue([]) }
    const client = {
      venue: { findFirst: vi.fn().mockResolvedValue(base.venue) },
      place: scopedEmpty,
      venueKnowledgeEntry: { findMany: vi.fn().mockResolvedValue([]) },
      operationalUpdate: { findMany: vi.fn().mockResolvedValue([]) },
      contentModuleRevision,
      contentVersion: { aggregate: vi.fn().mockResolvedValue({ _max: { sequence: null } }) },
    }
    const result = await createVenueContentSnapshot({
      db: client as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      asOf: new Date('2026-08-11T12:00:00Z'),
    })
    expect(contentModuleRevision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          audience: 'PUBLIC',
        }),
      }),
    )
    expect(JSON.stringify(result.manifest)).not.toContain('internal secret')
  })
})
