import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@pathfinder/db', () => ({ db: {}, readNativeSalesSnapshot: vi.fn(), withTenantIsolationBypass: async (fn: () => unknown) => fn() }))
vi.mock('./prospect-sales-workflow', () => ({ getNativeSalesWorkflow: vi.fn() }))
import { createOutreachCohortService, type OutreachCohortActor } from './prospect-outreach-cohort'
const actor: OutreachCohortActor = { id: 'synthetic-actor', type: 'HUMAN', runId: 'synthetic-run',
  scope: { mode: 'ALL' }, capabilities: ['prospects.read', 'prospects.correspondence.read', 'prospects.maintain'] }
const hash = 'a'.repeat(64), token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const state = (i: number) => ({ schema: 'torchiko.outreach-cohort-member/1', revision: 1, attempt: 0, state: 'RESERVED', reasons: [], lease: null, task: null, draft: null,
  selection: { venueId: `v${i}`, organizationId: `o${i}`, name: `Synthetic ${i}`, recipient: `fixture${i}@example.invalid`, nativeSnapshotHash: hash } })
function fixture() {
  const group = { id: 'group', name: 'Synthetic group', status: 'DRAFT', pausedAt: null, updatedAt: new Date('2026-09-23T00:00:00Z'),
    cohortSnapshot: { schema: 'torchiko.outreach-preparation-cohort/1', question: 'A bounded synthetic test.' },
    members: [1, 2].map(i => ({ id: `m${i}`, organizationId: `o${i}`, venueId: `v${i}`, contactId: `c${i}`, selection: state(i), updatedAt: new Date('2026-09-23T00:00:00Z') })) }
  const client: any = {
    prospectOutreachCampaign: { findUnique: vi.fn(async () => structuredClone(group)), findFirst: vi.fn(async () => ({ id: 'cursor' })),
      findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    prospectOrganization: { count: vi.fn(async () => 2) }, prospectCampaignMember: { updateMany: vi.fn(async () => ({ count: 1 })) },
    prospectActivity: { create: vi.fn(), findUnique: vi.fn() }, prospectOutreachDraft: { findUnique: vi.fn() },
  }
  client.$transaction = async (fn: (tx: unknown) => unknown) => fn(client)
  const readView = vi.fn(async (venueId: string) => ({ venueId, snapshotHash: hash, routing: { kind: 'email', value: `${venueId}@example.invalid` },
    suppression: { blocked: false, reasons: [] }, draft: null, preparation: null, writerHold: null, sourceState: 'SYNTHETIC',
    threadCandidates: [], outreachState: 'UNPREPARED', correspondenceState: 'NO_RETAINED_HISTORY', SEND_AUTHORIZED: false }) as any)
  return { group, client, readView, service: createOutreachCohortService({ client, readView, now: () => new Date('2026-09-23T21:00:00Z') }) }
}
describe('native cohort service integration', () => {
  beforeEach(() => vi.clearAllMocks())
  it('exports actual list, with exact bounded cursor pagination and complete organization predicates', async () => {
    const { client, service } = fixture()
    client.prospectOutreachCampaign.findMany.mockResolvedValue(['one', 'two', 'three'].map(id => ({ id, name: id, status: 'DRAFT',
      createdAt: new Date('2026-09-23T00:00:00Z'), updatedAt: new Date('2026-09-23T00:00:00Z'), _count: { members: 50 } })))
    const result = await service.list({ limit: 2, cursor: 'cursor' }, { ...actor, scope: { mode: 'TERRITORIES', territoryIds: ['t1'] } })
    expect(result.items.map(v => v.cohortId)).toEqual(['one', 'two']); expect(result.nextCursor).toBe('two')
    const query = client.prospectOutreachCampaign.findMany.mock.calls[0][0]
    expect(query.take).toBe(3); expect(query.skip).toBe(1); expect(query.cursor).toEqual({ id: 'cursor' })
    expect(query.where.members.every.organization.AND[1].venues.every).toBeDefined()
    await expect(service.list({ limit: 51 }, actor)).rejects.toThrow()
    client.prospectOutreachCampaign.findFirst.mockResolvedValue(null)
    await expect(service.list({ cursor: 'foreign-or-deleted' }, actor)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('rejects missing correspondence/maintenance authority and empty scopes before data access', async () => {
    const { client, service } = fixture()
    await expect(service.list({}, { ...actor, capabilities: ['prospects.read'] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.list({}, { ...actor, scope: { mode: 'TERRITORIES', territoryIds: [] } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.reserve({}, { ...actor, capabilities: ['prospects.read', 'prospects.correspondence.read'] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(client.prospectOutreachCampaign.findMany).not.toHaveBeenCalled()
  })
  it('revalidates a live grant before returning directory content', async () => {
    const { client, readView } = fixture(); client.prospectOutreachCampaign.findMany.mockResolvedValue([])
    const service = createOutreachCohortService({ client, readView, revalidate: async () => { throw Error('Grant withdrawn') } })
    await expect(service.list({}, actor)).rejects.toThrow('Grant withdrawn')
  })
  it('retains every unavailable member as held rather than pretending no draft or history', async () => {
    const { service, readView } = fixture(); readView.mockRejectedValue(Error('Actual reader unavailable'))
    const review = await service.read({ cohortId: 'group' }, actor)
    expect(review.rows).toHaveLength(2); expect(review.readyForHumanReview).toBe(0)
    expect(review.rows.every(r => r.nativeRead === 'UNAVAILABLE' && r.suppression.blocked && r.correspondenceState === 'UNAVAILABLE')).toBe(true)
    await expect(service.acknowledge({ cohortId: 'group', expectedReviewHash: review.reviewHash, expectedCount: 2,
      acknowledgement: 'I reviewed these exact messages and holds. This is not sending approval.' }, actor)).rejects.toMatchObject({ code: 'HELD' })
  })
  it('rejects partial territory access and group state changes during a read', async () => {
    const { group, client, service } = fixture(); client.prospectOrganization.count.mockResolvedValueOnce(1)
    await expect(service.read({ cohortId: 'group' }, actor)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    client.prospectOutreachCampaign.findUnique.mockResolvedValueOnce(structuredClone(group)).mockResolvedValueOnce({ ...structuredClone(group), status: 'PAUSED' })
    await expect(service.read({ cohortId: 'group' }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('rejects agent acknowledgement/group control and exact stale review hashes', async () => {
    const { service } = fixture()
    const input = { cohortId: 'group', expectedReviewHash: '0'.repeat(64), expectedCount: 2,
      acknowledgement: 'I reviewed these exact messages and holds. This is not sending approval.' }
    await expect(service.acknowledge(input, { ...actor, type: 'AGENT' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.acknowledge(input, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(service.control({ cohortId: 'group', requestKey: 'control', action: 'cancel', reason: 'Explicit synthetic cancellation.', expectedReviewHash: hash },
      { ...actor, type: 'AGENT' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('rejects a forged import receipt before it can replace any native checkpoint', async () => {
    const { group, client, service } = fixture()
    Object.assign(group.members[0]!.selection, { state: 'PREPARING', task: { id: 'task', preparationId: 'preparation' },
      lease: { token, actorId: actor.id, runId: actor.runId, expiresAt: '2026-09-23T21:10:00Z' } })
    client.prospectActivity.findUnique.mockResolvedValue({ organizationId: 'foreign', venueId: 'v1', evidence: {} })
    client.prospectOutreachDraft.findUnique.mockResolvedValue({ id: 'forged-draft' })
    await expect(service.checkpoint({ action: 'imported', cohortId: 'group', memberId: 'm1', leaseToken: token,
      receiptId: 'forged', draftId: 'forged-draft' }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(client.prospectCampaignMember.updateMany).not.toHaveBeenCalled()
  })
})
