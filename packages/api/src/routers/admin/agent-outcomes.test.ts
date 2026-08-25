import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  findMany: vi.fn(),
  findManyProposals: vi.fn(),
  record: vi.fn(),
  recordTrustSignal: vi.fn(),
  prepareProposal: vi.fn(),
  recordValidation: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  AgentOutcomeActionError: class AgentOutcomeActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  AgentImprovementProposalActionError: class AgentImprovementProposalActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  AgentImprovementValidationActionError: class AgentImprovementValidationActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  prepareAgentImprovementProposalAction: mocks.prepareProposal,
  recordAgentImprovementValidationAction: mocks.recordValidation,
  recordAgentOutcomeAction: mocks.record,
  recordAgentTrustSignalAction: mocks.recordTrustSignal,
  withTenantIsolationBypass: mocks.bypass,
  db: {
    agentOutcomeObservation: { findMany: mocks.findMany },
    agentImprovementProposal: { findMany: mocks.findManyProposals },
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminAgentOutcomesRouter } from './agent-outcomes'

const testRouter = router({ admin: adminAgentOutcomesRouter })

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator-1',
      activeTenantId: 'tenant-other',
      role: 'STAFF',
      isPlatformAdmin,
    },
  }
}

describe('admin agent outcomes router', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects non-admin writes before bypassing tenant isolation', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.recordAgentRunOutcome({
        operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentRunId: 'run-1',
        verdict: 'POSITIVE',
        summary: 'Useful result.',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })

  it('records a human review with session-derived authority', async () => {
    mocks.record.mockResolvedValue({ id: 'outcome-1', replayed: false })
    const result = await testRouter.createCaller(context()).admin.recordAgentRunOutcome({
      operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentRunId: 'run-1',
      verdict: 'MIXED',
      summary: ' Useful after one correction. ',
      evidenceRef: ' decision-42 ',
    })

    expect(result).toEqual({ id: 'outcome-1', replayed: false })
    expect(mocks.record).toHaveBeenCalledWith(
      {
        operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentRunId: 'run-1',
        verdict: 'MIXED',
        summary: 'Useful after one correction.',
        evidenceRef: 'decision-42',
        actor: { type: 'HUMAN', id: 'operator-1', role: 'PLATFORM_ADMIN' },
      },
      expect.anything(),
    )
  })

  it('records structured trust evidence with session-derived authority', async () => {
    mocks.recordTrustSignal.mockResolvedValue({ id: 'outcome-trust-1', replayed: false })
    const result = await testRouter.createCaller(context()).admin.recordAgentTrustSignal({
      operationId: '2d4ee39a-a7c7-44ab-bf24-75c187cff002',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentRunId: 'run-1',
      signalKind: 'CONFIDENCE_CALIBRATION',
      predictionRef: 'answer-7',
      predictedConfidenceBps: 8200,
      actualCorrect: true,
      summary: ' Reviewed answer was correct. ',
      evidenceRef: ' eval-run-42 ',
    })

    expect(result).toEqual({ id: 'outcome-trust-1', replayed: false })
    expect(mocks.recordTrustSignal).toHaveBeenCalledWith(
      {
        operationId: '2d4ee39a-a7c7-44ab-bf24-75c187cff002',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentRunId: 'run-1',
        signalKind: 'CONFIDENCE_CALIBRATION',
        predictionRef: 'answer-7',
        predictedConfidenceBps: 8200,
        actualCorrect: true,
        summary: 'Reviewed answer was correct.',
        evidenceRef: 'eval-run-42',
        actor: { type: 'HUMAN', id: 'operator-1', role: 'PLATFORM_ADMIN' },
      },
      expect.anything(),
    )
  })

  it('rejects non-admin trust evidence before bypassing tenant isolation', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.recordAgentTrustSignal({
        operationId: '2d4ee39a-a7c7-44ab-bf24-75c187cff002',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentRunId: 'run-1',
        signalKind: 'ROLLBACK',
        relatedAgentActionId: 'action-1',
        summary: 'The action required rollback.',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.recordTrustSignal).not.toHaveBeenCalled()
  })

  it('lists only the requested tenant, venue, run, identity, and signal scope', async () => {
    mocks.findMany.mockResolvedValue([])
    const result = await testRouter.createCaller(context()).admin.listAgentOutcomeObservations({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentRunId: 'run-1',
      agentIdentityId: 'agent-1',
      signalKind: 'HUMAN_REVIEW',
      limit: 25,
    })

    expect(result).toEqual({ items: [], nextCursor: null })
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          agentRunId: 'run-1',
          agentIdentityId: 'agent-1',
          signalKind: 'HUMAN_REVIEW',
        }),
        take: 26,
      }),
    )
  })

  it('prepares a versioned review proposal with session-derived authority', async () => {
    mocks.prepareProposal.mockResolvedValue({ id: 'proposal-1', replayed: false })
    const result = await testRouter.createCaller(context()).admin.prepareAgentImprovementProposal({
      operationId: 'ba99cd03-9310-4aa2-84d7-4fe808b3f0df',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      outcomeObservationIds: ['outcome-1'],
      proposalKey: 'research-source-grounding',
      revision: 1,
      targetKind: 'RETRIEVAL',
      title: 'Ground research answers in current sources',
      hypothesis: 'Retrieval misses are causing unsupported recommendations.',
      proposedChange: 'Require current-source retrieval before each recommendation.',
      validationPlan: 'Replay affected cases and compare outcomes before any rollout.',
    })

    expect(result).toEqual({ id: 'proposal-1', replayed: false })
    expect(mocks.prepareProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalKey: 'research-source-grounding',
        actor: { type: 'HUMAN', id: 'operator-1', role: 'PLATFORM_ADMIN' },
      }),
      expect.anything(),
    )
  })

  it('rejects non-admin improvement proposals before bypassing tenant isolation', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.prepareAgentImprovementProposal({
        operationId: 'ba99cd03-9310-4aa2-84d7-4fe808b3f0df',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentIdentityId: 'agent-1',
        outcomeObservationIds: ['outcome-1'],
        proposalKey: 'research-source-grounding',
        revision: 1,
        targetKind: 'RETRIEVAL',
        title: 'Ground research answers in current sources',
        hypothesis: 'Retrieval misses are causing unsupported recommendations.',
        proposedChange: 'Require current-source retrieval before each recommendation.',
        validationPlan: 'Replay affected cases and compare outcomes before any rollout.',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.prepareProposal).not.toHaveBeenCalled()
  })

  it('lists proposals through exact tenant and target filters', async () => {
    mocks.findManyProposals.mockResolvedValue([])
    const result = await testRouter.createCaller(context()).admin.listAgentImprovementProposals({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      taskClass: 'research',
      targetKind: 'RETRIEVAL',
      limit: 25,
    })

    expect(result).toEqual({ items: [], nextCursor: null })
    expect(mocks.findManyProposals).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          agentIdentityId: 'agent-1',
          taskClass: 'research',
          targetKind: 'RETRIEVAL',
        }),
        take: 26,
      }),
    )
  })

  it('records reviewed implementation and before/after evidence with session authority', async () => {
    mocks.recordValidation.mockResolvedValue({ id: 'validation-1', replayed: false })
    const result = await testRouter.createCaller(context()).admin.recordAgentImprovementValidation({
      operationId: 'ca99cd03-9310-4aa2-84d7-4fe808b3f0df',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      proposalId: 'proposal-1',
      baselineEvalRunId: '11111111-1111-4111-8111-111111111111',
      candidateEvalRunId: '22222222-2222-4222-8222-222222222222',
      implementationKind: 'CODE_COMMIT',
      implementationRef: 'git:3e3d8a3',
      implementationVersion: '3e3d8a3',
      implementationHash: 'a'.repeat(64),
      changeDimensions: ['MODEL'],
    })

    expect(result).toEqual({ id: 'validation-1', replayed: false })
    expect(mocks.recordValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: 'proposal-1',
        actor: { type: 'HUMAN', id: 'operator-1', role: 'PLATFORM_ADMIN' },
      }),
      expect.anything(),
    )
  })

  it('rejects non-admin validation records before bypassing tenant isolation', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.recordAgentImprovementValidation({
        operationId: 'ca99cd03-9310-4aa2-84d7-4fe808b3f0df',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        proposalId: 'proposal-1',
        baselineEvalRunId: '11111111-1111-4111-8111-111111111111',
        candidateEvalRunId: '22222222-2222-4222-8222-222222222222',
        implementationKind: 'CODE_COMMIT',
        implementationRef: 'git:3e3d8a3',
        implementationHash: 'a'.repeat(64),
        changeDimensions: ['MODEL'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.recordValidation).not.toHaveBeenCalled()
  })
})
