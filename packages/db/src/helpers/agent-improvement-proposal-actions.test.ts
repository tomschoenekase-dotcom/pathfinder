import { describe, expect, it, vi } from 'vitest'

import {
  AgentImprovementProposalActionError,
  prepareAgentImprovementProposalAction,
} from './agent-improvement-proposal-actions'

const input = {
  operationId: 'ba99cd03-9310-4aa2-84d7-4fe808b3f0df',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  agentIdentityId: 'agent-1',
  outcomeObservationIds: ['outcome-2', 'outcome-1'],
  proposalKey: 'research-source-grounding',
  revision: 1,
  targetKind: 'RETRIEVAL' as const,
  title: 'Ground research answers in current sources',
  hypothesis: 'Retrieval misses are causing correctable unsupported recommendations.',
  proposedChange: 'Require current-source retrieval before producing a recommendation.',
  validationPlan: 'Replay the affected cases and compare accepted outcomes before any rollout.',
  actor: { type: 'HUMAN' as const, id: 'operator-1', role: 'PLATFORM_ADMIN' as const },
}

const observations = [
  {
    id: 'outcome-1',
    taskClass: 'research',
    verdict: 'NEGATIVE' as const,
    signalKind: 'HUMAN_REVIEW',
    modelProvider: 'provider-a',
    modelName: 'model-a',
    createdAt: new Date('2026-08-20T12:00:00Z'),
  },
  {
    id: 'outcome-2',
    taskClass: 'research',
    verdict: 'MIXED' as const,
    signalKind: 'QUALITY_EVALUATION',
    modelProvider: 'provider-a',
    modelName: 'model-a',
    createdAt: new Date('2026-08-21T12:00:00Z'),
  },
]

function client(transaction: Record<string, unknown>) {
  return {
    $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(transaction)),
  }
}

function created() {
  return {
    id: 'proposal-1',
    operationId: input.operationId,
    tenantId: input.tenantId,
    venueId: input.venueId,
    agentIdentityId: input.agentIdentityId,
    approvalRequestId: 'approval-1',
    proposalKey: input.proposalKey,
    revision: 1,
    supersedesProposalId: null,
    taskClass: 'research',
    targetKind: input.targetKind,
    title: input.title,
    hypothesis: input.hypothesis,
    proposedChange: input.proposedChange,
    validationPlan: input.validationPlan,
    baselineSnapshot: {},
    createdByType: 'HUMAN',
    createdById: 'operator-1',
    createdAt: new Date('2026-08-22T12:00:00Z'),
    evidence: [{ outcomeObservationId: 'outcome-1' }, { outcomeObservationId: 'outcome-2' }],
    approvalRequest: { id: 'approval-1', riskCategory: 'MEDIUM', decision: null },
  }
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    agentImprovementProposal: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(created()),
    },
    agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent-1' }) },
    agentOutcomeObservation: { findMany: vi.fn().mockResolvedValue(observations) },
    approvalRequest: { create: vi.fn().mockResolvedValue({ id: 'approval-1' }) },
    agentRun: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    agentAction: { create: vi.fn() },
    agentTimelineEvent: { create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    ...overrides,
  }
}

describe('agent improvement proposal actions', () => {
  it('creates a review-only proposal with exact evidence and a descriptive baseline', async () => {
    const tx = transaction()
    const result = await prepareAgentImprovementProposalAction(input, client(tx) as never)

    expect(result).toEqual({ ...created(), replayed: false })
    expect(tx.agentOutcomeObservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          agentIdentityId: 'agent-1',
        }),
      }),
    )
    expect(tx.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          proposedAction: 'torchiko.agent-improvement.review-proposal',
          riskCategory: 'MEDIUM',
          scopeSnapshot: expect.objectContaining({ executionTriggeredByDecision: false }),
        }),
      }),
    )
    expect(tx.agentImprovementProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskClass: 'research',
          baselineSnapshot: expect.objectContaining({
            observationCount: 2,
            verdictCounts: { POSITIVE: 0, MIXED: 1, NEGATIVE: 1, INCONCLUSIVE: 0 },
            interpretation: 'descriptive-evidence-only',
          }),
          evidence: {
            create: [{ outcomeObservationId: 'outcome-1' }, { outcomeObservationId: 'outcome-2' }],
          },
        }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })

  it('replays exact content without creating another approval', async () => {
    const tx = transaction({
      agentImprovementProposal: {
        findFirst: vi.fn().mockResolvedValue(created()),
        create: vi.fn(),
      },
    })

    const result = await prepareAgentImprovementProposalAction(input, client(tx) as never)

    expect(result).toEqual({ ...created(), replayed: true })
    expect(tx.approvalRequest.create).not.toHaveBeenCalled()
  })

  it('rejects evidence outside the exact tenant, venue, and target identity scope', async () => {
    const tx = transaction({
      agentOutcomeObservation: { findMany: vi.fn().mockResolvedValue([observations[0]]) },
    })

    await expect(
      prepareAgentImprovementProposalAction(input, client(tx) as never),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<AgentImprovementProposalActionError>)
    expect(tx.approvalRequest.create).not.toHaveBeenCalled()
  })

  it('does not turn exclusively positive evidence into an improvement proposal', async () => {
    const tx = transaction({
      agentOutcomeObservation: {
        findMany: vi
          .fn()
          .mockResolvedValue(observations.map((item) => ({ ...item, verdict: 'POSITIVE' }))),
      },
    })

    await expect(
      prepareAgentImprovementProposalAction(input, client(tx) as never),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    } satisfies Partial<AgentImprovementProposalActionError>)
    expect(tx.approvalRequest.create).not.toHaveBeenCalled()
  })

  it('requires an exact immediately preceding revision', async () => {
    const tx = transaction()
    tx.agentImprovementProposal.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    await expect(
      prepareAgentImprovementProposalAction(
        { ...input, revision: 2, supersedesProposalId: 'proposal-old' },
        client(tx) as never,
      ),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<AgentImprovementProposalActionError>)
  })

  it('lets an exactly scoped worker prepare review evidence without applying the change', async () => {
    const tx = transaction({
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'run-proposer',
          requestedOperation: 'agent-improvement.propose',
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentAction: { create: vi.fn().mockResolvedValue({ id: 'action-1' }) },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'timeline-1' }) },
    })
    const agentInput = {
      ...input,
      actor: {
        type: 'AGENT' as const,
        actorId: 'agent-1',
        role: 'AGENT' as const,
        agentIdentityId: 'agent-1',
        agentRunId: 'run-proposer',
        workerId: 'worker-1',
        credentialId: 'credential-1',
        capability: 'agent-improvements:propose',
        idempotencyKey: input.operationId,
      },
    }
    tx.agentImprovementProposal.create.mockResolvedValue({
      ...created(),
      createdByType: 'AGENT',
      createdById: 'agent-1',
    })

    const result = await prepareAgentImprovementProposalAction(agentInput, client(tx) as never)

    expect(result.replayed).toBe(false)
    expect(tx.agentAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionName: 'torchiko.agent_improvements.propose',
          output: expect.objectContaining({ executionTriggered: false }),
        }),
      }),
    )
    expect(tx.agentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'AWAITING_APPROVAL' } }),
    )
    expect(tx.agentTimelineEvent.create).toHaveBeenCalledOnce()
  })
})
