import { describe, expect, it, vi } from 'vitest'

import {
  AgentOutcomeActionError,
  recordAgentOutcomeAction,
  recordAgentTrustSignalAction,
} from './agent-outcome-actions'

const input = {
  operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  agentRunId: 'run-1',
  verdict: 'MIXED' as const,
  summary: 'The recommendation was useful after correcting the cost estimate.',
  evidenceRef: 'decision-42',
  actor: { type: 'HUMAN' as const, id: 'operator-1', role: 'PLATFORM_ADMIN' as const },
}

function client(transaction: Record<string, unknown>) {
  return {
    $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(transaction)),
  }
}

function created() {
  return {
    id: 'outcome-1',
    operationId: input.operationId,
    tenantId: input.tenantId,
    venueId: input.venueId,
    agentRunId: input.agentRunId,
    agentIdentityId: 'agent-1',
    signalKind: 'HUMAN_REVIEW',
    verdict: input.verdict,
    summary: input.summary,
    evidenceRef: input.evidenceRef,
    taskClass: 'research',
    modelProvider: 'hermes-bridge',
    modelName: 'researcher',
    actorType: input.actor.type,
    actorId: input.actor.id,
    createdAt: new Date('2026-08-18T22:30:00Z'),
  }
}

describe('agent outcome actions', () => {
  it('records explicit outcome evidence with frozen run and model identity', async () => {
    const outcome = created()
    const transaction = {
      agentOutcomeObservation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(outcome),
      },
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'run-1',
          agentIdentityId: 'agent-1',
          runType: 'research',
          modelProvider: 'hermes-bridge',
          modelName: 'researcher',
        }),
      },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }

    const result = await recordAgentOutcomeAction(input, client(transaction) as never)

    expect(result).toEqual({ ...outcome, replayed: false })
    expect(transaction.agentRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] } }),
      }),
    )
    expect(transaction.agentOutcomeObservation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          signalKind: 'HUMAN_REVIEW',
          taskClass: 'research',
          modelProvider: 'hermes-bridge',
          modelName: 'researcher',
        }),
      }),
    )
    expect(transaction.agentTimelineEvent.create).toHaveBeenCalledOnce()
    expect(transaction.auditLog.create).toHaveBeenCalledOnce()
  })

  it('replays the same operation without duplicate timeline or audit evidence', async () => {
    const outcome = created()
    const transaction = {
      agentOutcomeObservation: {
        findFirst: vi.fn().mockResolvedValue(outcome),
        create: vi.fn(),
      },
      agentRun: { findFirst: vi.fn() },
      agentTimelineEvent: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    }

    const result = await recordAgentOutcomeAction(input, client(transaction) as never)

    expect(result).toEqual({ ...outcome, replayed: true })
    expect(transaction.agentRun.findFirst).not.toHaveBeenCalled()
    expect(transaction.agentOutcomeObservation.create).not.toHaveBeenCalled()
    expect(transaction.agentTimelineEvent.create).not.toHaveBeenCalled()
    expect(transaction.auditLog.create).not.toHaveBeenCalled()
  })

  it('rejects a reused operation ID carrying different evidence', async () => {
    const transaction = {
      agentOutcomeObservation: {
        findFirst: vi.fn().mockResolvedValue(created()),
      },
    }

    await expect(
      recordAgentOutcomeAction(
        { ...input, summary: 'A different conclusion.' },
        client(transaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<AgentOutcomeActionError>)
  })

  it('does not label an active or out-of-scope run', async () => {
    const transaction = {
      agentOutcomeObservation: { findFirst: vi.fn().mockResolvedValue(null) },
      agentRun: { findFirst: vi.fn().mockResolvedValue(null) },
    }

    await expect(
      recordAgentOutcomeAction(input, client(transaction) as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<AgentOutcomeActionError>)
  })
})

describe('agent operational trust signals', () => {
  const trustBase = {
    operationId: '3d539cea-428b-467c-8ff9-a3f8f64e4f38',
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    agentRunId: 'run-1',
    summary: 'The original action required a reviewed rollback.',
    evidenceRef: 'incident-42',
    actor: { type: 'HUMAN' as const, id: 'operator-1', role: 'PLATFORM_ADMIN' as const },
  }

  function trustTransaction(createdSignal: Record<string, unknown>) {
    return {
      agentOutcomeObservation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(createdSignal),
      },
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'run-1',
          agentIdentityId: 'agent-1',
          runType: 'support',
          modelProvider: 'hermes-bridge',
          modelName: 'support-worker',
        }),
      },
      agentAction: { findFirst: vi.fn().mockResolvedValue({ id: 'action-1' }) },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }
  }

  it('records a rollback only against an action in the same terminal run', async () => {
    const transaction = trustTransaction({
      id: 'outcome-rollback',
      signalKind: 'ROLLBACK',
      verdict: 'NEGATIVE',
      relatedAgentActionId: 'action-1',
      policyCode: null,
      severity: null,
      predictionRef: null,
      predictedConfidenceBps: null,
      actualCorrect: null,
      evidenceRef: trustBase.evidenceRef,
    })

    const result = await recordAgentTrustSignalAction(
      { ...trustBase, signalKind: 'ROLLBACK', relatedAgentActionId: 'action-1' },
      client(transaction) as never,
    )

    expect(result).toMatchObject({
      signalKind: 'ROLLBACK',
      verdict: 'NEGATIVE',
      relatedAgentActionId: 'action-1',
      replayed: false,
    })
    expect(transaction.agentAction.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'action-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentRunId: 'run-1',
        agentIdentityId: 'agent-1',
        status: 'SUCCEEDED',
      },
      select: { id: true },
    })
    expect(transaction.agentTimelineEvent.create).toHaveBeenCalledOnce()
    expect(transaction.auditLog.create).toHaveBeenCalledOnce()
  })

  it('records explicit policy code and severity without confusing a denial for a violation', async () => {
    const transaction = trustTransaction({
      id: 'outcome-policy',
      signalKind: 'POLICY_VIOLATION',
      verdict: 'NEGATIVE',
      relatedAgentActionId: null,
      policyCode: 'customer-contact-without-approval',
      severity: 'HIGH',
      predictionRef: null,
      predictedConfidenceBps: null,
      actualCorrect: null,
      evidenceRef: trustBase.evidenceRef,
    })

    await recordAgentTrustSignalAction(
      {
        ...trustBase,
        signalKind: 'POLICY_VIOLATION',
        policyCode: 'customer-contact-without-approval',
        severity: 'HIGH',
      },
      client(transaction) as never,
    )

    expect(transaction.agentAction.findFirst).not.toHaveBeenCalled()
    expect(transaction.agentOutcomeObservation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          signalKind: 'POLICY_VIOLATION',
          verdict: 'NEGATIVE',
          policyCode: 'customer-contact-without-approval',
          severity: 'HIGH',
        }),
      }),
    )
  })

  it('retains an exact confidence prediction paired with reviewed correctness', async () => {
    const transaction = trustTransaction({
      id: 'outcome-confidence',
      signalKind: 'CONFIDENCE_CALIBRATION',
      verdict: 'POSITIVE',
      relatedAgentActionId: null,
      policyCode: null,
      severity: null,
      predictionRef: 'answer-7',
      predictedConfidenceBps: 8200,
      actualCorrect: true,
      evidenceRef: trustBase.evidenceRef,
    })

    await recordAgentTrustSignalAction(
      {
        ...trustBase,
        signalKind: 'CONFIDENCE_CALIBRATION',
        predictionRef: 'answer-7',
        predictedConfidenceBps: 8200,
        actualCorrect: true,
      },
      client(transaction) as never,
    )

    expect(transaction.agentOutcomeObservation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          signalKind: 'CONFIDENCE_CALIBRATION',
          verdict: 'POSITIVE',
          predictionRef: 'answer-7',
          predictedConfidenceBps: 8200,
          actualCorrect: true,
        }),
      }),
    )
  })

  it('rejects a rollback action outside the run scope', async () => {
    const transaction = trustTransaction({})
    transaction.agentAction.findFirst.mockResolvedValue(null)

    await expect(
      recordAgentTrustSignalAction(
        { ...trustBase, signalKind: 'ROLLBACK', relatedAgentActionId: 'action-other' },
        client(transaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<AgentOutcomeActionError>)
  })
})
