import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  get: vi.fn(),
  plan: vi.fn(),
  audit: vi.fn(),
  start: vi.fn(),
  finish: vi.fn(),
  stop: vi.fn(),
  complete: vi.fn(),
  admission: vi.fn(),
  place: vi.fn(),
  knowledge: vi.fn(),
  env: { EMBEDDING_DISPATCH_ENABLED: false },
}))
vi.mock('@pathfinder/config', () => ({ env: mocks.env }))
vi.mock('@pathfinder/db', () => ({
  db: {},
  assertVenueAiAvailable: mocks.admission,
  claimVenueEmbeddingRefresh: mocks.claim,
  getVenueEmbeddingRefresh: mocks.get,
  planVenueEmbeddingRefresh: mocks.plan,
  auditEmbeddingFreshness: mocks.audit,
  startVenueEmbeddingRefreshRecord: mocks.start,
  finishVenueEmbeddingRefreshRecord: mocks.finish,
  stopVenueEmbeddingRefresh: mocks.stop,
  completeVenueEmbeddingRefresh: mocks.complete,
}))
vi.mock('./embed-place', () => ({ processEmbedPlaceJob: mocks.place }))
vi.mock('./embed-knowledge-entry', () => ({ processEmbedKnowledgeEntryJob: mocks.knowledge }))
import { processVenueEmbeddingRefreshJob } from './refresh-venue-embeddings'
const payload = { tenantId: 'tenant-a', venueId: 'harbor-gallery', refreshId: 'refresh-a' }
const records = ['PLACE', 'KNOWLEDGE_ENTRY'].map((entityType, ordinal) => ({
  id: `record-${ordinal}`,
  ordinal,
  entityType,
  entityId: `entity-${ordinal}`,
  contentUpdatedAt: new Date('2026-10-01'),
  sourceHash: `hash-${ordinal}`,
  embeddingProfile: 'profile',
  primaryReason: 'missing-vector-no-claim',
  status: 'PENDING',
}))
const run = {
  id: payload.refreshId,
  status: 'RUNNING',
  planDigest: 'digest',
  maxRecords: 2,
  records,
}
function audit(complete = -1) {
  return {
    truncated: false,
    candidates: records.map((record, index) => ({
      ...record,
      ...payload,
      actionable: index > complete,
      primaryReason: index <= complete ? 'current-complete' : 'missing-vector-no-claim',
    })),
  }
}
const plan = {
  eligible: true,
  truncated: false,
  blockedCount: 0,
  planDigest: 'digest',
  candidateCount: 2,
  manifest: records,
  beforeAudit: { candidateCount: 0, blockedCount: 0, truncated: false },
}
describe('serial venue embedding refresh', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('EMBEDDING_DISPATCH_ENABLED', 'false')
    mocks.env.EMBEDDING_DISPATCH_ENABLED = false
    mocks.claim.mockResolvedValue({ acquired: true, refresh: run })
    mocks.get.mockResolvedValue(run)
    mocks.plan.mockResolvedValue(plan)
    mocks.start.mockResolvedValue({ acquired: true, refresh: run })
    mocks.finish.mockResolvedValue({ acquired: true, refresh: run })
    mocks.complete.mockResolvedValue({
      acquired: true,
      refresh: { ...run, status: 'COMPLETE', freshnessProven: true },
    })
    mocks.audit
      .mockResolvedValueOnce(audit())
      .mockResolvedValueOnce(audit(0))
      .mockResolvedValueOnce(audit(0))
      .mockResolvedValueOnce(audit(1))
  })
  afterEach(() => vi.unstubAllEnvs())
  it('persists each receipt before serial provider work and proves exact completion', async () => {
    const events: string[] = []
    mocks.start.mockImplementation(async ({ recordId }) => {
      events.push(`start-${recordId}`)
      return { acquired: true }
    })
    mocks.place.mockImplementation(async () => {
      events.push('place')
    })
    mocks.knowledge.mockImplementation(async () => {
      events.push('knowledge')
    })
    mocks.finish.mockImplementation(async ({ recordId }) => {
      events.push(`finish-${recordId}`)
      return { acquired: true }
    })
    expect(await processVenueEmbeddingRefreshJob(payload)).toMatchObject({
      status: 'COMPLETE',
      freshnessProven: true,
    })
    expect(events).toEqual([
      'start-record-0',
      'place',
      'finish-record-0',
      'start-record-1',
      'knowledge',
      'finish-record-1',
    ])
    expect(mocks.place).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVenueId: payload.venueId,
        expectedSourceHash: 'hash-0',
        expectedEmbeddingProfile: 'profile',
      }),
      { bullJobId: 'refresh-a-0', attemptNumber: 1, maxAttempts: 1 },
    )
    expect(mocks.plan).toHaveBeenCalledTimes(2)
  })
  it.each(['RUNNING', 'COMPLETE', 'STOPPED', 'OUTCOME_UNKNOWN'])(
    'never takes over %s redelivery',
    async (status) => {
      mocks.claim.mockResolvedValue({ acquired: false, refresh: { ...run, status } })
      await processVenueEmbeddingRefreshJob(payload)
      expect(mocks.plan).not.toHaveBeenCalled()
      expect(mocks.place).not.toHaveBeenCalled()
    },
  )
  it.each(['true', ''])('refuses a flag that is not explicitly false (%s)', async (flag) => {
    vi.stubEnv('EMBEDDING_DISPATCH_ENABLED', flag)
    await processVenueEmbeddingRefreshJob(payload)
    expect(mocks.place).not.toHaveBeenCalled()
    expect(mocks.stop).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DISPATCHER_MUST_BE_EXPLICITLY_DISABLED', unknown: false }),
    )
  })
  it('stops before provider if the sealed digest changed', async () => {
    mocks.plan.mockResolvedValue({ ...plan, planDigest: 'changed' })
    await processVenueEmbeddingRefreshJob(payload)
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it.each(['current-running', 'dispatch-leased', 'complete-claim-missing-vector-invariant-breach'])(
    'respects %s blockers',
    async (reason) => {
      mocks.audit.mockReset().mockResolvedValue({
        ...audit(),
        candidates: [{ ...audit().candidates[0], primaryReason: reason }],
      })
      await processVenueEmbeddingRefreshJob(payload)
      expect(mocks.place).not.toHaveBeenCalled()
    },
  )
  it('does no provider work after an uncertain start receipt', async () => {
    mocks.start.mockRejectedValue(new Error('database unavailable'))
    await processVenueEmbeddingRefreshJob(payload)
    expect(mocks.place).not.toHaveBeenCalled()
    expect(mocks.stop).toHaveBeenCalledWith(expect.objectContaining({ unknown: true }))
  })
  it('stops after the first provider failure without another record or retry', async () => {
    mocks.place.mockRejectedValue(new Error('provider timeout with private details'))
    await processVenueEmbeddingRefreshJob(payload)
    expect(mocks.place).toHaveBeenCalledTimes(1)
    expect(mocks.knowledge).not.toHaveBeenCalled()
    expect(mocks.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: {
          status: 'OUTCOME_UNKNOWN',
          code: 'RECORD_ATTEMPT_OUTCOME_UNKNOWN',
        },
      }),
    )
  })
  it('does not treat a skipped processor as completion', async () => {
    mocks.audit.mockReset().mockResolvedValue(audit())
    await processVenueEmbeddingRefreshJob(payload)
    expect(mocks.knowledge).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.stop).toHaveBeenCalledWith(expect.objectContaining({ unknown: true }))
  })
  it('stops if the successful receipt cannot be persisted', async () => {
    mocks.finish.mockRejectedValue(new Error('database unavailable'))
    await expect(processVenueEmbeddingRefreshJob(payload)).rejects.toThrow(
      'EMBEDDING_REFRESH_RECEIPT_UNAVAILABLE',
    )
    expect(mocks.knowledge).not.toHaveBeenCalled()
  })
  it('stops for admission refusal without delayed work', async () => {
    mocks.admission.mockRejectedValue(new Error('budget denied'))
    await processVenueEmbeddingRefreshJob(payload)
    expect(mocks.place).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
  })
  it.each(['sourceHash', 'embeddingProfile', 'entityId'])(
    'refuses changed %s before provider',
    async (field) => {
      const changed = audit()
      changed.candidates[0] = { ...changed.candidates[0]!, [field]: 'changed' }
      mocks.audit.mockReset().mockResolvedValue(changed)
      await processVenueEmbeddingRefreshJob(payload)
      expect(mocks.start).not.toHaveBeenCalled()
    },
  )
  it('passes an incomplete final audit to durable completion without claiming freshness', async () => {
    const incomplete = { candidateCount: 1, blockedCount: 0, truncated: false }
    mocks.plan
      .mockResolvedValueOnce(plan)
      .mockResolvedValueOnce({ ...plan, beforeAudit: incomplete })
    mocks.complete.mockResolvedValue({
      acquired: true,
      refresh: { ...run, status: 'STOPPED', freshnessProven: false },
    })
    expect(await processVenueEmbeddingRefreshJob(payload)).toMatchObject({
      status: 'STOPPED',
      freshnessProven: false,
    })
    expect(mocks.complete).toHaveBeenCalledWith({ ...payload, afterAudit: incomplete })
  })
  it('never marks a venue disabled during work as complete', async () => {
    mocks.plan.mockResolvedValueOnce(plan).mockResolvedValueOnce({ ...plan, eligible: false })
    await processVenueEmbeddingRefreshJob(payload)
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.stop).toHaveBeenCalledWith(expect.objectContaining({ unknown: false }))
  })
})
