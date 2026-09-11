import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  available: vi.fn(),
  query: vi.fn(),
  assets: vi.fn(),
  save: vi.fn(),
}))
vi.mock('@pathfinder/config', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  db: {
    mediaEntityResolutionRevision: { findFirst: mocks.findFirst },
    $queryRaw: mocks.query,
    mediaIngestionAsset: { findMany: mocks.assets },
  },
  assertVenueAvailable: mocks.available,
  withTenantIsolationBypass: async <T>(fn: () => Promise<T>) => fn(),
}))
vi.mock('../../lib/media-resolution-service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/media-resolution-service')>()
  return { ...original, saveMediaResolution: mocks.save }
})
import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { mediaIntakeHash } from '../../lib/media-intake-snapshot'
import { mediaIngestionResolutionRouter } from './media-ingestion-resolution'

const scope = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  projectId: 'project-a',
  sourceGeneration: '11111111-1111-4111-8111-111111111111',
}
const revisionId = '22222222-2222-4222-8222-222222222222'
const testRouter = router({ media: mediaIngestionResolutionRouter })
function caller(isPlatformAdmin = true) {
  return testRouter.createCaller({
    db: {} as never,
    headers: new Headers(),
    session: { userId: 'admin-a', activeTenantId: null, role: null, isPlatformAdmin },
  } as TRPCContext)
}
beforeEach(() => vi.resetAllMocks())

describe('identity review authority and evidence reads', () => {
  it('takes mutation identity only from the platform-admin session', async () => {
    const input = {
      ...scope,
      requestId: revisionId,
      expectedUpdatedAt: '2026-09-07T09:00:00.000Z',
      expectedRevision: 1,
      decision: {
        kind: 'MERGE' as const,
        candidateIds: ['a', 'b'],
        representativeId: 'a',
        rationale: 'Same sign.',
      },
    }
    await expect(caller(false).media.saveIdentityReview(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(mocks.save).not.toHaveBeenCalled()
    await caller().media.saveIdentityReview(input)
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ input, actorId: 'admin-a' }))
    mocks.save.mockClear()
    await expect(
      caller().media.saveIdentityReview({ ...input, actorId: 'forged' } as typeof input),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('rejects non-admin reads before database access', async () => {
    await expect(caller(false).media.getIdentityReview(scope)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(caller(false).media.previewIdentityCandidates(scope)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      caller(false).media.readIdentityEvidence({ ...scope, revisionId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.available).not.toHaveBeenCalled()
    expect(mocks.findFirst).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })
  it('requires venue availability before reading retained evidence', async () => {
    mocks.available.mockRejectedValue(new Error('Venue unavailable'))
    await expect(caller().media.readIdentityEvidence({ ...scope, revisionId })).rejects.toThrow(
      'Venue unavailable',
    )
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })
  it('reassembles Unicode evidence through bounded pages scoped to one exact revision', async () => {
    const evidenceSnapshot = {
      sources: [{ sourceId: 'image-a', uncertainties: ['Identity unconfirmed.'] }],
      evidence: ['😀'.repeat(24_000)],
    }
    const evidenceSnapshotHash = mediaIntakeHash(evidenceSnapshot)
    mocks.findFirst.mockResolvedValue({ id: revisionId, evidenceSnapshot, evidenceSnapshotHash })
    let offset = 0
    let retained = ''
    for (;;) {
      const page = await caller().media.readIdentityEvidence({ ...scope, revisionId, offset })
      expect(page.text.length).toBeLessThanOrEqual(20_000)
      expect(page.snapshotHash).toBe(evidenceSnapshotHash)
      expect(page.sourceCount).toBe(1)
      expect(/[\uD800-\uDBFF]$/u.test(page.text)).toBe(false)
      retained += page.text
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    }
    expect(JSON.parse(retained)).toEqual(evidenceSnapshot)
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { ...scope, id: revisionId },
      select: { id: true, evidenceSnapshot: true, evidenceSnapshotHash: true },
    })
  })
  it('rejects changed evidence and invalid offsets', async () => {
    const evidenceSnapshot = { evidence: ['😀'] }
    mocks.findFirst.mockResolvedValue({
      id: revisionId,
      evidenceSnapshot,
      evidenceSnapshotHash: 'a'.repeat(64),
    })
    await expect(
      caller().media.readIdentityEvidence({ ...scope, revisionId }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    mocks.findFirst.mockResolvedValue({
      id: revisionId,
      evidenceSnapshot,
      evidenceSnapshotHash: mediaIntakeHash(evidenceSnapshot),
    })
    const text = JSON.stringify(evidenceSnapshot, null, 2)
    await expect(
      caller().media.readIdentityEvidence({ ...scope, revisionId, offset: text.indexOf('😀') + 1 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller().media.readIdentityEvidence({ ...scope, revisionId, offset: text.length + 1 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('rejects an unavailable current review before querying its assets', async () => {
    mocks.query.mockResolvedValue([])
    await expect(caller().media.previewIdentityCandidates(scope)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(mocks.assets).not.toHaveBeenCalled()
  })
})
