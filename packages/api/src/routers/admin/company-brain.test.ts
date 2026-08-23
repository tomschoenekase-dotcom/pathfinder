import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  findMany: vi.fn(),
  createCandidate: vi.fn(),
  applyDecisionPacket: vi.fn(),
  getFounderDecisions: vi.fn(),
  promote: vi.fn(),
  createTask: vi.fn(),
  enqueue: vi.fn(),
  meeting: vi.fn(),
  identity: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({ env: { AGENT_RUNNER_ENABLED: false } }))
vi.mock('@pathfinder/jobs', () => ({ enqueueAgentRun: mocks.enqueue }))

vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: mocks.bypass,
  createCompanyKnowledgeCandidateAction: mocks.createCandidate,
  applyFounderDecisionPacketAction: mocks.applyDecisionPacket,
  getFounderDecisionCurrentTruth: mocks.getFounderDecisions,
  promoteCompanyKnowledgeAction: mocks.promote,
  createAgentTaskAction: mocks.createTask,
  db: {
    companyKnowledgeItem: { findMany: mocks.findMany },
    companyMeeting: { findFirst: mocks.meeting },
    agentIdentity: { findFirst: mocks.identity },
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminCompanyBrainRouter } from './company-brain'

const testRouter = router({ companyBrain: adminCompanyBrainRouter })

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

describe('Company Brain admin router', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects non-admin reads before platform bypass', async () => {
    await expect(
      testRouter.createCaller(context(false)).companyBrain.listCompanyBrain({}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(mocks.bypass).not.toHaveBeenCalled()
  })

  it('returns only a bounded real-data projection', async () => {
    mocks.findMany.mockResolvedValue([])
    const result = await testRouter
      .createCaller(context(true))
      .companyBrain.listCompanyBrain({ status: 'CURRENT', limit: 25 })
    expect(result).toEqual({ schemaVersion: 'company-brain-admin.v1', items: [], truncated: false })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }))
  })

  it('creates and promotes a human-attributed first-class decision', async () => {
    mocks.createCandidate.mockResolvedValue({ id: 'knowledge_1' })
    mocks.promote.mockResolvedValue({ id: 'knowledge_1', promotionStatus: 'PROMOTED' })
    await testRouter.createCaller(context(true)).companyBrain.createCompanyDecision({
      requestId: '11111111-1111-4111-8111-111111111111',
      title: 'Custom character pricing',
      summary: 'Custom characters use add-on pricing.',
      decision: 'Charge the approved add-on price.',
      rationale: 'Custom production has material cost.',
      affectedSystems: ['billing'],
      scope: { productArea: 'characters' },
    })
    expect(mocks.createCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DECISION',
        authority: 'AUTHORITATIVE_CURRENT',
        decision: expect.objectContaining({ status: 'ACTIVE' }),
        actor: { type: 'HUMAN', actorId: 'operator_1', role: 'PLATFORM_ADMIN' },
      }),
    )
    expect(mocks.promote).toHaveBeenCalled()
  })

  it('applies a bounded founder packet as the authenticated human administrator', async () => {
    mocks.applyDecisionPacket.mockResolvedValue({
      schemaVersion: 'founder-decision-packet-result.v1',
      packetId: 'founder-direction-2026-08-22',
      packetHash: 'abc',
      results: [],
    })
    const packet = {
      schemaVersion: 'founder-decision-packet.v1' as const,
      packetId: 'founder-direction-2026-08-22',
      title: 'Founder direction',
      effectiveAt: '2026-08-22T05:00:00.000Z',
      sourceRef: 'vault://07 Decisions/Torchiko Founder Engineering Direction 2026-08-22.md',
      decisions: [
        {
          key: 'codex-autonomy',
          title: 'Codex autonomy',
          summary: 'Delegate ordinary engineering decisions.',
          decision: 'Make the best reasonable technical decision and keep moving.',
          rationale: 'Founder judgment should be reserved for consequential boundaries.',
          affectedSystems: ['engineering'],
          scope: { productionAuthorized: false },
        },
      ],
    }
    await testRouter.createCaller(context(true)).companyBrain.applyFounderDecisionPacket(packet)
    expect(mocks.applyDecisionPacket).toHaveBeenCalledWith({
      packet,
      actor: { type: 'HUMAN', actorId: 'operator_1', role: 'PLATFORM_ADMIN' },
    })
    await expect(
      testRouter.createCaller(context(false)).companyBrain.applyFounderDecisionPacket(packet),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(mocks.applyDecisionPacket).toHaveBeenCalledTimes(1)
  })

  it('resolves exact current founder decisions only after platform-admin authorization', async () => {
    mocks.getFounderDecisions.mockResolvedValue({
      schemaVersion: 'founder-decision-current-truth.v1',
      complete: true,
      decisions: [{ key: 'production-release-boundary' }],
      missingKeys: [],
    })
    const request = { keys: ['production-release-boundary'] }
    await expect(
      testRouter.createCaller(context(true)).companyBrain.getFounderDecisionCurrentTruth(request),
    ).resolves.toMatchObject({ complete: true })
    expect(mocks.getFounderDecisions).toHaveBeenCalledWith(request)
    await expect(
      testRouter.createCaller(context(false)).companyBrain.getFounderDecisionCurrentTruth(request),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(mocks.getFounderDecisions).toHaveBeenCalledTimes(1)
  })

  it('queues meeting processing through the existing durable AgentRun system', async () => {
    mocks.meeting.mockResolvedValue({
      id: 'meeting_1',
      title: 'Client review',
      sourceArtifactRef: 'drive://meeting-1',
    })
    mocks.identity.mockResolvedValue({ id: 'agent_1' })
    mocks.createTask.mockResolvedValue({
      run: { id: 'run_1', status: 'QUEUED' },
      replayed: false,
      executionTriggered: false,
    })
    mocks.enqueue.mockResolvedValue({ enqueued: true })
    const result = await testRouter
      .createCaller(context(true))
      .companyBrain.queueCompanyMeetingProcessing({
        requestId: '11111111-1111-4111-8111-111111111111',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        meetingId: 'meeting_1',
        agentIdentityId: 'agent_1',
      })
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: '11111111-1111-4111-8111-111111111111',
        promptIdentity: 'company-meeting-processing.v1',
      }),
      expect.anything(),
    )
    expect(result).toMatchObject({ executionTriggered: true, sourceArtifactAvailable: true })
  })
})
