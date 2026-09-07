import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  preview: vi.fn(),
  clarify: vi.fn(),
  operational: vi.fn(),
}))
vi.mock('@pathfinder/config', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  db: {},
  assertVenueAvailable: mocks.available,
  withTenantIsolationBypass: async <T>(fn: () => Promise<T>) => fn(),
}))
vi.mock('../../lib/media-temporal-review', async (original) => {
  const actual = await original<typeof import('../../lib/media-temporal-review')>()
  return { ...actual, previewMediaTemporalReview: mocks.preview }
})
vi.mock('../../lib/media-temporal-clarification', async (original) => {
  const actual = await original<typeof import('../../lib/media-temporal-clarification')>()
  return { ...actual, createMediaTemporalClarification: mocks.clarify }
})

vi.mock('../../lib/media-temporal-operational-service', async (original) => {
  const actual = await original<typeof import('../../lib/media-temporal-operational-service')>()
  return { ...actual, createMediaTemporalOperationalHandoff: mocks.operational }
})

import { createHash } from 'node:crypto'
import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { mediaIngestionTemporalRouter } from './media-ingestion-temporal'

const testRouter = router({ mediaIngestion: mediaIngestionTemporalRouter })
const value = 'Open'
const input = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  projectId: 'project-a',
  sourceGeneration: '22222222-2222-4222-8222-222222222222',
  expectedUpdatedAt: '2026-09-07T10:00:00.000Z',
  claims: [
    {
      claimId: 'claim-a',
      targetKey: 'place:a:hours',
      targetItemHash: 'a'.repeat(64),
      claimType: 'STABLE_FACT' as const,
      value,
      valueHash: createHash('sha256').update(value).digest('hex'),
      authority: 'UNKNOWN' as const,
      consequential: true,
      source: {
        sourceId: 'source-a',
        sourceSha256: 'b'.repeat(64),
        sourceVersion: 'attempt-a',
        capturedAt: null,
        observationIndex: 0,
        observationSha256: 'c'.repeat(64),
      },
    },
  ],
}
function caller(isPlatformAdmin = true) {
  return testRouter.createCaller({
    db: {} as never,
    headers: new Headers(),
    session: { userId: 'admin-a', activeTenantId: null, role: null, isPlatformAdmin },
  } as TRPCContext)
}

beforeEach(() => vi.clearAllMocks())
describe('media temporal review admin route', () => {
  it('gates dated drafts and binds the authenticated actor without activation input', async () => {
    const draft = {
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      reviewReceiptId: '11111111-1111-4111-8111-111111111111',
      requestId: '22222222-2222-4222-8222-222222222222',
      claimId: 'hours',
      expectedSnapshotHash: 'a'.repeat(64),
      rationale: 'Reviewed current hours',
      title: 'Holiday hours',
      updateType: 'CHANGED_HOURS' as const,
      severity: 'INFO' as const,
      priority: 'NORMAL' as const,
    }
    await expect(
      caller(false).mediaIngestion.createTemporalOperationalDraft(draft),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.operational).not.toHaveBeenCalled()
    mocks.available.mockRejectedValueOnce(new Error('Venue unavailable'))
    await expect(caller().mediaIngestion.createTemporalOperationalDraft(draft)).rejects.toThrow(
      'Venue unavailable',
    )
    expect(mocks.operational).not.toHaveBeenCalled()
    await expect(
      caller().mediaIngestion.createTemporalOperationalDraft({ ...draft, isActive: true } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    mocks.operational.mockResolvedValue({ createdAs: 'INACTIVE_DRAFT' })
    await expect(caller().mediaIngestion.createTemporalOperationalDraft(draft)).resolves.toEqual({
      createdAs: 'INACTIVE_DRAFT',
    })
    expect(mocks.operational).toHaveBeenCalledWith({ client: {}, input: draft, actorId: 'admin-a' })
  })

  it('requires platform authority and venue availability before creating a local clarification', async () => {
    const clarification = {
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      agentIdentityId: 'agent-a',
      targetKey: 'hours',
      expectedSnapshotHash: 'a'.repeat(64),
    }
    await expect(
      caller(false).mediaIngestion.createTemporalClarification(clarification),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.clarify).not.toHaveBeenCalled()
    mocks.available.mockRejectedValueOnce(new Error('Venue unavailable'))
    await expect(
      caller().mediaIngestion.createTemporalClarification(clarification),
    ).rejects.toThrow('Venue unavailable')
    expect(mocks.clarify).not.toHaveBeenCalled()
    mocks.clarify.mockResolvedValue({ blockerScope: 'LOCAL' })
    await expect(
      caller().mediaIngestion.createTemporalClarification(clarification),
    ).resolves.toEqual({ blockerScope: 'LOCAL' })
  })
  it('checks venue authority and supplies server evaluation time', async () => {
    mocks.preview.mockResolvedValue({ reconciliation: { blockedTargetKeys: [] } })
    await expect(caller().mediaIngestion.previewTemporalReview(input)).resolves.toEqual({
      reconciliation: { blockedTargetKeys: [] },
    })
    expect(mocks.available).toHaveBeenCalledWith({}, { tenantId: 'tenant-a', venueId: 'venue-a' })
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        db: {},
        input,
        evaluatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      }),
    )
  })

  it('rejects non-platform-admin callers before any project read', async () => {
    await expect(caller(false).mediaIngestion.previewTemporalReview(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(mocks.preview).not.toHaveBeenCalled()
  })
})
