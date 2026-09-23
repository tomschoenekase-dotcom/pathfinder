import { beforeEach, describe, expect, it, vi } from 'vitest'

const guestRead = vi.hoisted(() => vi.fn())
vi.mock('./native-guest-content-read', () => ({ resolveNativeGuestReadSnapshotAction: guestRead }))

import { resolveVenueLaunchSource } from './venue-launch-source'

const venue = {
  id: 'venue-a', name: 'Museum', slug: 'museum', isActive: true,
  description: 'Public museum', guideNotes: null, aiGuideNotes: null,
}
const place = { id: 'place-a', name: 'Clock', type: 'EXHIBIT', itemType: null,
  shortDescription: 'Public clock', longDescription: null, tags: [] }

function fixture() {
  const client = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'venue-a', tenantId: 'tenant-a' }]),
    venue: { findFirst: vi.fn().mockResolvedValue(venue) },
    place: { findMany: vi.fn().mockResolvedValue([place]) },
    venueKnowledgeEntry: { findMany: vi.fn().mockResolvedValue([]) },
    tenantFeatureFlag: { findFirst: vi.fn() },
    nativeVenueDeploymentHead: { findFirst: vi.fn() },
    nativeVenueDeploymentEvaluationEvidence: { findFirst: vi.fn() },
  }
  return { client, tenantId: 'tenant-a', venueId: 'venue-a',
    configuredOrigin: 'https://guide.example.com' }
}
const source = (input: ReturnType<typeof fixture>) =>
  resolveVenueLaunchSource({ ...input, client: input.client as never })

describe('venue launch source', () => {
  beforeEach(() => {
    guestRead.mockReset()
    guestRead.mockResolvedValue({ path: 'LEGACY', releaseId: null, state: null })
  })

  it('binds the exact public destination and stable public legacy content revision', async () => {
    const input = fixture()
    const first = await source(input)
    expect(first).toMatchObject({ publicUrl: 'https://guide.example.com/museum/chat?source=qr',
      release: { kind: 'LEGACY', id: expect.stringMatching(/^legacy:[a-f0-9]{64}$/u) } })
    expect(input.client.place.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 'tenant-a', venueId: 'venue-a',
        isActive: true, visibility: 'PUBLIC' }), take: 1001,
    }))
    expect((await source(input))?.release.revisionSha256).toBe(first?.release.revisionSha256)
    input.client.place.findMany.mockResolvedValue([{ ...place, name: 'New public name' }])
    expect((await source(input))?.release.revisionSha256)
      .not.toBe(first?.release.revisionSha256)
  })

  it('fails closed on no public content, unsafe origin, and unbounded public content', async () => {
    const input = fixture()
    input.client.place.findMany.mockResolvedValue([])
    expect(await source(input)).toBeNull()
    input.client.place.findMany.mockResolvedValue([place])
    expect(await source({ ...input, configuredOrigin: 'http://guide.example.com' })).toBeNull()
    input.client.place.findMany.mockResolvedValue(Array.from({ length: 1001 }, (_, index) => ({ ...place, id: `p${index}` })))
    expect(await source(input)).toBeNull()
  })

  it('refuses ambiguous or wrong-tenant public slugs', async () => {
    const input = fixture()
    input.client.$queryRaw.mockResolvedValue([{ id: 'venue-a', tenantId: 'tenant-a' }, { id: 'other', tenantId: 'other' }])
    expect(await source(input)).toBeNull()
    input.client.$queryRaw.mockResolvedValue([{ id: 'other', tenantId: 'other' }])
    expect(await source(input)).toBeNull()
  })

  it('does not label a dark or inactive native head as the served release', async () => {
    guestRead.mockResolvedValue({ path: 'DARK', releaseId: 'native-r1', state: {} })
    expect((await source(fixture()))?.release.kind).toBe('LEGACY')
  })
})
