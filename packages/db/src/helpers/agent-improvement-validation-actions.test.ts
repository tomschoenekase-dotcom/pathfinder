import { describe, expect, it, vi } from 'vitest'

import {
  AgentImprovementValidationActionError,
  recordAgentImprovementValidationAction,
} from './agent-improvement-validation-actions'

const baselineId = '11111111-1111-4111-8111-111111111111'
const candidateId = '22222222-2222-4222-8222-222222222222'
const caseId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const input = {
  operationId: 'ba99cd03-9310-4aa2-84d7-4fe808b3f0df',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  proposalId: 'proposal-1',
  baselineEvalRunId: baselineId,
  candidateEvalRunId: candidateId,
  implementationKind: 'CODE_COMMIT' as const,
  implementationRef: 'git:3e3d8a3',
  implementationVersion: '3e3d8a3',
  implementationHash: 'a'.repeat(64),
  changeDimensions: ['MODEL' as const],
  actor: { type: 'HUMAN' as const, id: 'operator-1', role: 'PLATFORM_ADMIN' as const },
}

function run(id: string, modelName: string) {
  return {
    id,
    identityHash: (id === baselineId ? '1' : '2').repeat(64),
    corpusHash: 'c'.repeat(64),
    caseManifestSnapshot: [{ caseId, revision: 1, caseHash: 'd'.repeat(64) }],
    promptContractVersion: 'prompt-v1',
    promptContractHash: 'e'.repeat(64),
    packageSnapshotRef: null,
    packageSnapshotHash: null,
    contentSnapshotKind: 'NATIVE_CORE_V1',
    contentSnapshotRef: 'release-1',
    contentSnapshotVersion: 1n,
    contentSnapshotHash: 'f'.repeat(64),
    modelProvider: 'openai',
    modelName,
    modelSnapshotHash: (modelName === 'baseline' ? '7' : '8').repeat(64),
    runConfigSnapshot: { temperature: 0 },
    status: 'COMPLETED',
    createdAt: new Date(),
  }
}

function saved(overrides: Record<string, unknown> = {}) {
  return {
    id: 'validation-1',
    operationId: input.operationId,
    tenantId: input.tenantId,
    venueId: input.venueId,
    proposalId: input.proposalId,
    approvalDecisionId: 'decision-1',
    baselineEvalRunId: baselineId,
    candidateEvalRunId: candidateId,
    implementationKind: input.implementationKind,
    implementationRef: input.implementationRef,
    implementationVersion: input.implementationVersion,
    implementationHash: input.implementationHash,
    changeDimensions: ['MODEL'],
    comparisonSnapshot: {},
    comparisonHash: '9'.repeat(64),
    recordedByType: 'HUMAN',
    recordedById: 'operator-1',
    createdAt: new Date(),
    ...overrides,
  }
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    agentImprovementValidationEvidence: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(saved()),
    },
    agentImprovementProposal: {
      findFirst: vi.fn().mockResolvedValue({
        id: input.proposalId,
        agentIdentityId: 'target-agent',
        taskClass: 'research',
        approvalRequest: { decision: { id: 'decision-1', decision: 'APPROVED' } },
      }),
    },
    agentIdentity: { findFirst: vi.fn() },
    agentRun: { findFirst: vi.fn() },
    evalRun: {
      findMany: vi
        .fn()
        .mockResolvedValue([run(baselineId, 'baseline'), run(candidateId, 'candidate')]),
    },
    evalCase: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          {
            id: caseId,
            caseKey: 'grounding',
            revision: 1,
            caseHash: 'd'.repeat(64),
            category: 'quality',
          },
        ]),
    },
    evalResult: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'result-before',
          runId: baselineId,
          caseId,
          caseRevision: 1,
          caseHash: 'd'.repeat(64),
          outcome: 'SCORED',
          passed: false,
          passedChecks: 1,
          totalChecks: 2,
          errorCode: null,
          latencyMs: 100,
          costE8Usd: 100n,
          reviews: [],
        },
        {
          id: 'result-after',
          runId: candidateId,
          caseId,
          caseRevision: 1,
          caseHash: 'd'.repeat(64),
          outcome: 'SCORED',
          passed: true,
          passedChecks: 2,
          totalChecks: 2,
          errorCode: null,
          latencyMs: 110,
          costE8Usd: 120n,
          reviews: [],
        },
      ]),
    },
    agentAction: { create: vi.fn() },
    agentTimelineEvent: { create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    ...overrides,
  }
}

function client(tx: Record<string, unknown>) {
  return { $transaction: vi.fn(async (callback: (value: unknown) => unknown) => callback(tx)) }
}

describe('agent improvement validation actions', () => {
  it('binds an approved proposal to immutable implementation and comparable before/after evidence', async () => {
    const tx = transaction()
    const result = await recordAgentImprovementValidationAction(input, client(tx) as never)

    expect(result.replayed).toBe(false)
    expect(tx.agentImprovementValidationEvidence.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvalDecisionId: 'decision-1',
          changeDimensions: ['MODEL'],
          comparisonSnapshot: expect.objectContaining({
            status: 'COMPARABLE_WITH_DECLARED_CHANGE',
            interpretation: 'evidence-only-no-promotion-threshold',
            totals: expect.objectContaining({ resolvedFailures: 1, newFailures: 0 }),
          }),
        }),
      }),
    )
    expect(tx.agentAction.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })

  it('requires the proposal review to be explicitly approved', async () => {
    const tx = transaction({
      agentImprovementProposal: {
        findFirst: vi.fn().mockResolvedValue({
          id: input.proposalId,
          approvalRequest: { decision: null },
        }),
      },
    })
    await expect(
      recordAgentImprovementValidationAction(input, client(tx) as never),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    } satisfies Partial<AgentImprovementValidationActionError>)
    expect(tx.evalRun.findMany).not.toHaveBeenCalled()
  })

  it('fails closed when an undeclared content difference makes the runs incomparable', async () => {
    const tx = transaction()
    tx.evalRun.findMany.mockResolvedValue([
      run(baselineId, 'baseline'),
      { ...run(candidateId, 'candidate'), contentSnapshotHash: '0'.repeat(64) },
    ])
    await expect(
      recordAgentImprovementValidationAction(input, client(tx) as never),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    } satisfies Partial<AgentImprovementValidationActionError>)
    expect(tx.agentImprovementValidationEvidence.create).not.toHaveBeenCalled()
  })

  it('returns an exact idempotent replay without recomputing evaluation evidence', async () => {
    const tx = transaction({
      agentImprovementValidationEvidence: {
        findFirst: vi.fn().mockResolvedValue(saved()),
        create: vi.fn(),
      },
    })
    await expect(
      recordAgentImprovementValidationAction(input, client(tx) as never),
    ).resolves.toMatchObject({ id: 'validation-1', replayed: true })
    expect(tx.agentImprovementProposal.findFirst).not.toHaveBeenCalled()
  })

  it('records agent identity, model, run, cost, and before/after references without promotion', async () => {
    const tx = transaction({
      agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'validator-agent' }) },
      agentRun: { findFirst: vi.fn().mockResolvedValue({ id: 'validator-run' }) },
      agentAction: { create: vi.fn().mockResolvedValue({ id: 'action-1' }) },
    })
    tx.agentImprovementValidationEvidence.create.mockResolvedValue(
      saved({ recordedByType: 'AGENT', recordedById: 'validator-agent' }),
    )
    const agentInput = {
      ...input,
      actor: {
        type: 'AGENT' as const,
        actorId: 'validator-agent',
        role: 'AGENT' as const,
        agentIdentityId: 'validator-agent',
        agentRunId: 'validator-run',
        workerId: 'worker-1',
        credentialId: 'credential-1',
        capability: 'agent-improvements:validate',
        modelProvider: 'openai',
        modelName: 'gpt-validator',
        idempotencyKey: input.operationId,
      },
    }

    await recordAgentImprovementValidationAction(agentInput, client(tx) as never)
    expect(tx.agentAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelProvider: 'openai',
          modelName: 'gpt-validator',
          costE8Usd: 0,
          beforeVersionRef: `EvalRun:${baselineId}`,
          afterVersionRef: `EvalRun:${candidateId}`,
          output: expect.objectContaining({ behaviorChanged: false, authorityChanged: false }),
        }),
      }),
    )
    expect(tx.agentTimelineEvent.create).toHaveBeenCalledOnce()
  })
})
