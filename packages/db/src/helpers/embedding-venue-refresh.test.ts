import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ audit: vi.fn() }))
vi.mock('../client', () => ({ db: {} }))
vi.mock('./embedding-freshness', () => ({ auditEmbeddingFreshness: mocks.audit }))
import {
  claimVenueEmbeddingRefresh,
  completeVenueEmbeddingRefresh,
  findVenueEmbeddingRefreshByOperation,
  finishVenueEmbeddingRefreshRecord,
  getVenueEmbeddingRefresh,
  planVenueEmbeddingRefresh,
  requestVenueEmbeddingRefresh,
  startVenueEmbeddingRefreshRecord,
  stopVenueEmbeddingRefresh,
} from './embedding-venue-refresh'
import type { db } from '../client'

const scope = { tenantId: 'fictional-tenant', venueId: 'fictional-gallery' }
const summary = { scanned: 1, truncated: false, groups: [], candidateCount: 1, blockedCount: 0 }
const candidate = {
  ...scope,
  entityType: 'PLACE',
  entityId: 'fictional-exhibit',
  contentUpdatedAt: new Date('2026-10-01'),
  sourceHash: 'hash-a',
  embeddingProfile: 'profile-a',
  primaryReason: 'missing-vector-no-claim',
  actionable: true,
  signals: [],
}
function database() {
  const client = {
    venue: { findFirst: vi.fn().mockResolvedValue({ isActive: true }) },
    embeddingVenueRefresh: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'refresh-a' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    embeddingVenueRefreshRecord: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(0),
    },
    $transaction: vi.fn(),
  }
  client.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(client))
  return client
}
function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 'refresh-a',
    ...scope,
    operationKey: 'operation-a',
    planDigest: 'digest-a',
    maxRecords: 1,
    requestedBy: 'operator-a',
    status: 'QUEUED',
    beforeAudit: summary,
    afterAudit: null,
    stopCode: null,
    records: [],
    ...overrides,
  }
}
const asDb = (client: ReturnType<typeof database>) => client as unknown as typeof db
const identity = { ...scope, refreshId: 'refresh-a' }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('EMBEDDING_DISPATCH_ENABLED', 'false')
  mocks.audit.mockResolvedValue({
    ...scope,
    scanned: 1,
    truncated: false,
    groups: [
      { venueId: scope.venueId, entityType: 'PLACE', reason: 'missing-vector-no-claim', count: 1 },
    ],
    candidates: [candidate],
    actionableCandidates: [candidate],
  })
})
describe('venue embedding refresh durable boundaries', () => {
  it('plans without durable writes and binds hashes, profiles, revisions and scope', async () => {
    const client = database()
    const plan = await planVenueEmbeddingRefresh(scope, asDb(client))
    expect(client.embeddingVenueRefresh.create).not.toHaveBeenCalled()
    expect(client.$transaction).not.toHaveBeenCalled()
    for (const change of [
      { sourceHash: 'new' },
      { embeddingProfile: 'new' },
      { contentUpdatedAt: new Date('2026-10-02') },
    ]) {
      mocks.audit.mockResolvedValueOnce({
        ...scope,
        scanned: 1,
        truncated: false,
        groups: [
          {
            venueId: scope.venueId,
            entityType: 'PLACE',
            reason: 'missing-vector-no-claim',
            count: 1,
          },
        ],
        candidates: [{ ...candidate, ...change }],
        actionableCandidates: [{ ...candidate, ...change }],
      })
      expect((await planVenueEmbeddingRefresh(scope, asDb(client))).planDigest).not.toBe(
        plan.planDigest,
      )
    }
    expect((await planVenueEmbeddingRefresh(scope, asDb(client))).planDigest).toBe(plan.planDigest)
    expect(plan.manifest[0]).not.toHaveProperty('content')
  })
  it.each([-1, 1001, 1.5, NaN])('refuses invalid max %s before any read', async (max) => {
    const client = database()
    await expect(
      requestVenueEmbeddingRefresh(
        { ...scope, operationKey: 'op', planDigest: 'a', max, requestedBy: 'a' },
        asDb(client),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_MAX' })
    expect(client.venue.findFirst).not.toHaveBeenCalled()
  })
  it('refuses a too-small bound, stale digest, dispatcher and blocked audit', async () => {
    const client = database()
    const plan = await planVenueEmbeddingRefresh(scope, asDb(client))
    const input = {
      ...scope,
      operationKey: 'op',
      planDigest: plan.planDigest,
      max: 0,
      requestedBy: 'a',
    }
    await expect(requestVenueEmbeddingRefresh(input, asDb(client))).rejects.toMatchObject({
      code: 'MAX_EXCEEDED',
    })
    await expect(
      requestVenueEmbeddingRefresh({ ...input, max: 1, planDigest: 'changed' }, asDb(client)),
    ).rejects.toMatchObject({ code: 'PLAN_CHANGED' })
    vi.stubEnv('EMBEDDING_DISPATCH_ENABLED', 'true')
    await expect(requestVenueEmbeddingRefresh(input, asDb(client))).rejects.toMatchObject({
      code: 'DISPATCHER_ENABLED',
    })
    expect(client.embeddingVenueRefresh.create).not.toHaveBeenCalled()
  })
  it('replays immutable input without a fresh audit; refuses changed max/digest/actor', async () => {
    const client = database()
    client.embeddingVenueRefresh.findFirst.mockResolvedValue(run())
    const input = {
      ...scope,
      operationKey: 'operation-a',
      planDigest: 'digest-a',
      max: 1,
      requestedBy: 'operator-a',
    }
    expect((await requestVenueEmbeddingRefresh(input, asDb(client))).id).toBe('refresh-a')
    for (const change of [{ max: 2 }, { planDigest: 'changed' }, { requestedBy: 'changed' }])
      await expect(
        requestVenueEmbeddingRefresh({ ...input, ...change }, asDb(client)),
      ).rejects.toMatchObject({ code: 'OPERATION_MISMATCH' })
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('seals all manifest records with deterministic ordinals transactionally', async () => {
    const client = database()
    const plan = await planVenueEmbeddingRefresh(scope, asDb(client))
    client.embeddingVenueRefresh.findFirst.mockResolvedValueOnce(null).mockResolvedValue(run())
    await requestVenueEmbeddingRefresh(
      { ...scope, operationKey: 'op', planDigest: plan.planDigest, max: 1, requestedBy: 'a' },
      asDb(client),
    )
    expect(client.embeddingVenueRefreshRecord.createMany).toHaveBeenCalledWith({
      data: [{ ...plan.manifest[0], ordinal: 0, refreshId: 'refresh-a', ...scope }],
    })
  })
  it('maps active uniqueness refusal and reconciles concurrent same-operation creation', async () => {
    const client = database()
    const plan = await planVenueEmbeddingRefresh(scope, asDb(client))
    client.embeddingVenueRefresh.create.mockRejectedValue({ code: 'P2002' })
    await expect(
      requestVenueEmbeddingRefresh(
        { ...scope, operationKey: 'op', planDigest: plan.planDigest, max: 1, requestedBy: 'a' },
        asDb(client),
      ),
    ).rejects.toMatchObject({ code: 'ACTIVE_REFRESH' })
  })
  it('denies scope lookups and atomically claims queued runs once without takeover', async () => {
    const client = database()
    expect(await getVenueEmbeddingRefresh(identity, asDb(client))).toBeNull()
    expect(client.embeddingVenueRefresh.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'refresh-a', ...scope } }),
    )
    await findVenueEmbeddingRefreshByOperation({ ...scope, operationKey: 'op' }, asDb(client))
    expect(client.embeddingVenueRefresh.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { ...scope, operationKey: 'op' } }),
    )
    client.embeddingVenueRefresh.updateMany.mockResolvedValue({ count: 0 })
    expect((await claimVenueEmbeddingRefresh(identity, asDb(client))).acquired).toBe(false)
    expect(client.embeddingVenueRefresh.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 'refresh-a', ...scope, status: 'QUEUED' } }),
    )
  })
  it('never starts or finishes a record unless the scoped run is RUNNING', async () => {
    const client = database()
    client.embeddingVenueRefresh.updateMany.mockResolvedValue({ count: 0 })
    const record = { ...identity, recordId: 'record-a' }
    expect((await startVenueEmbeddingRefreshRecord(record, asDb(client))).acquired).toBe(false)
    expect(
      (
        await finishVenueEmbeddingRefreshRecord(
          { ...record, outcome: { status: 'COMPLETE' } },
          asDb(client),
        )
      ).acquired,
    ).toBe(false)
    expect(client.embeddingVenueRefreshRecord.updateMany).not.toHaveBeenCalled()
  })
  it('retains the active venue lock if any attempted record outcome is uncertain', async () => {
    const client = database()
    client.embeddingVenueRefreshRecord.count.mockResolvedValue(1)
    await stopVenueEmbeddingRefresh({ ...identity, code: 'provider secret raw text' }, asDb(client))
    expect(client.embeddingVenueRefresh.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'OUTCOME_UNKNOWN', stopCode: 'REFRESH_STOPPED' }),
      }),
    )
  })
  it('only proves freshness after complete receipts and a clean untruncated audit', async () => {
    const client = database()
    for (const afterAudit of [
      { ...summary, candidateCount: 1 },
      { ...summary, candidateCount: 0, truncated: true },
      { ...summary, candidateCount: 0, blockedCount: 1 },
    ]) {
      await completeVenueEmbeddingRefresh({ ...identity, afterAudit }, asDb(client))
      expect(client.embeddingVenueRefresh.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'STOPPED' }) }),
      )
    }
    await completeVenueEmbeddingRefresh(
      { ...identity, afterAudit: { ...summary, candidateCount: 0 } },
      asDb(client),
    )
    expect(client.embeddingVenueRefresh.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETE' }) }),
    )
  })
  it('accepts exactly zero records after a clean authoritative audit', async () => {
    mocks.audit.mockResolvedValue({
      ...scope,
      scanned: 0,
      truncated: false,
      groups: [],
      candidates: [],
      actionableCandidates: [],
    })
    const client = database()
    const plan = await planVenueEmbeddingRefresh(scope, asDb(client))
    client.embeddingVenueRefresh.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue(
        run({ status: 'COMPLETE', beforeAudit: plan.beforeAudit, afterAudit: plan.beforeAudit }),
      )
    const result = await requestVenueEmbeddingRefresh(
      { ...scope, operationKey: 'zero', planDigest: plan.planDigest, max: 0, requestedBy: 'a' },
      asDb(client),
    )
    expect(result.freshnessProven).toBe(true)
    expect(client.embeddingVenueRefreshRecord.createMany).not.toHaveBeenCalled()
    expect(client.embeddingVenueRefresh.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETE', maxRecords: 0 }),
      }),
    )
  })
  it.each(['current-running', 'dispatch-leased', 'complete-claim-missing-vector-invariant-breach'])(
    'refuses blocker %s before sealing',
    async (reason) => {
      mocks.audit.mockResolvedValue({
        ...scope,
        scanned: 1,
        truncated: false,
        groups: [{ venueId: scope.venueId, entityType: 'PLACE', reason, count: 1 }],
        candidates: [],
        actionableCandidates: [],
      })
      const client = database()
      const plan = await planVenueEmbeddingRefresh(scope, asDb(client))
      expect(plan.eligible).toBe(false)
      expect(plan.blockedCount).toBe(1)
      await expect(
        requestVenueEmbeddingRefresh(
          { ...scope, operationKey: 'op', planDigest: plan.planDigest, max: 1, requestedBy: 'a' },
          asDb(client),
        ),
      ).rejects.toMatchObject({ code: 'AUDIT_BLOCKED' })
    },
  )
  it('reconciles same-operation races only after immutable inputs match', async () => {
    const client = database()
    const plan = await planVenueEmbeddingRefresh(scope, asDb(client))
    client.embeddingVenueRefresh.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue(run({ planDigest: plan.planDigest }))
    client.embeddingVenueRefresh.create.mockRejectedValue({ code: 'P2002' })
    const result = await requestVenueEmbeddingRefresh(
      {
        ...scope,
        operationKey: 'operation-a',
        planDigest: plan.planDigest,
        max: 1,
        requestedBy: 'operator-a',
      },
      asDb(client),
    )
    expect(result.id).toBe('refresh-a')
  })
})
