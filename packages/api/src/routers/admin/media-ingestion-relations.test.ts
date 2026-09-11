import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ available: vi.fn(), apply: vi.fn() }))
vi.mock('@pathfinder/config', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  db: {},
  assertVenueAvailable: mocks.available,
  withTenantIsolationBypass: async <T>(fn: () => Promise<T>) => fn(),
}))
vi.mock('../../lib/media-relation-application-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/media-relation-application-service')>()),
  applyMediaRelationDraft: mocks.apply,
}))
import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { mediaIngestionRelationApplicationRouter } from './media-ingestion-relations'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const input = {
  tenantId: 'tenant',
  venueId: 'venue',
  projectId: 'project',
  sourceGeneration: uuid(1),
  revisionId: uuid(2),
  relationId: 'door',
  relationReviewRequestId: uuid(3),
  requestId: uuid(4),
  expectedMediaUpdatedAt: '2026-09-07T09:00:00.000Z',
  fromLocationId: uuid(5),
  fromLocationUpdatedAt: '2026-09-07T09:00:00.000Z',
  toLocationId: uuid(6),
  toLocationUpdatedAt: '2026-09-07T09:00:00.000Z',
  rationale: 'Verified both mapped anchors and path.',
}
const testRouter = router({ media: mediaIngestionRelationApplicationRouter })
function caller(isPlatformAdmin = true) {
  return testRouter.createCaller({
    db: {} as never,
    headers: new Headers(),
    session: { userId: 'admin', activeTenantId: null, role: null, isPlatformAdmin },
  } as TRPCContext)
}
beforeEach(() => vi.resetAllMocks())
describe('media canonical route application authority', () => {
  it('requires platform admin before any scope or mutation call', async () => {
    await expect(caller(false).media.applyReviewedRelationDraft(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(mocks.available).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
  })
  it('checks venue availability then binds the session actor', async () => {
    await caller().media.applyReviewedRelationDraft(input)
    expect(mocks.available).toHaveBeenCalledWith(expect.anything(), input)
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ input, actorId: 'admin' }))
    expect(mocks.available.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.apply.mock.invocationCallOrder[0]!,
    )
  })
  it('rejects forged actor and activation properties', async () => {
    for (const extra of [{ actorId: 'agent' }, { active: true }]) {
      await expect(
        caller().media.applyReviewedRelationDraft({ ...input, ...extra } as typeof input),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    }
    expect(mocks.apply).not.toHaveBeenCalled()
  })
})
