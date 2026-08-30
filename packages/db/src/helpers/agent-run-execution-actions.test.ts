import { describe, expect, it, vi } from 'vitest'

import {
  claimAgentRunExecution,
  failAgentRunExecution,
  heartbeatAgentRunExecution,
} from './agent-run-execution-actions'

const baseRun = {
  id: 'run-1',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  agentIdentityId: 'agent-1',
  runType: 'OPERATIONS',
  requestedOperation: 'operator_task',
  requestPrompt: 'Investigate.',
  scopeSnapshot: {},
  status: 'QUEUED',
  modelProvider: 'anthropic',
  modelName: 'claude-sonnet-4-6',
  cancelRequestedAt: null,
  executionLeaseExpiresAt: null,
  attemptNumber: 0,
  maxAttempts: 3,
  startedAt: null,
  agentIdentity: {
    identityKey: 'ops.primary',
    name: 'Ops',
    description: null,
    accessCapabilities: ['operations.read'],
    autonomyLevel: 'READ_ONLY',
    autonomousActions: [],
    enabled: true,
  },
}

function client(transaction: object) {
  return {
    $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(transaction)),
  }
}

describe('agent run execution actions', () => {
  it('atomically claims a queued run with a bounded lease and immutable attempt evidence', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue(baseRun),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
    }
    const result = await claimAgentRunExecution(
      { tenantId: 'tenant-1', runId: 'run-1', leaseDurationMs: 60_000 },
      client(transaction) as never,
    )
    expect(result.status).toBe('RUNNING')
    expect(result.attemptNumber).toBe(1)
    expect(result.leaseToken).toMatch(/^[0-9a-f-]{36}$/u)
    expect(transaction.agentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-1', attemptNumber: 0 }),
        data: expect.objectContaining({ status: 'RUNNING', attemptNumber: { increment: 1 } }),
      }),
    )
  })

  it('refuses a second claimant when compare-and-swap loses', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue(baseRun),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      agentTimelineEvent: { create: vi.fn() },
    }
    await expect(
      claimAgentRunExecution(
        { tenantId: 'tenant-1', runId: 'run-1' },
        client(transaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_CLAIMABLE' })
    expect(transaction.agentTimelineEvent.create).not.toHaveBeenCalled()
  })

  it('heartbeats only the exact live lease and surfaces cancellation intent', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({ cancelRequestedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const result = await heartbeatAgentRunExecution(
      {
        tenantId: 'tenant-1',
        runId: 'run-1',
        leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        leaseDurationMs: 60_000,
      },
      client(transaction) as never,
    )
    expect(result.cancelRequested).toBe(true)
  })

  it('requeues a retryable failure while attempts remain and clears the lease', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          venueId: 'venue-1',
          attemptNumber: 1,
          maxAttempts: 3,
          cancelRequestedAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
    }
    const result = await failAgentRunExecution(
      {
        tenantId: 'tenant-1',
        runId: 'run-1',
        leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        errorCode: 'TIMEOUT',
        retryable: true,
      },
      client(transaction) as never,
    )
    expect(result.status).toBe('QUEUED')
    expect(transaction.agentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'QUEUED', executionLeaseToken: null }),
      }),
    )
  })

  it('persists a stable code-derived terminal failure', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          venueId: 'venue-1',
          attemptNumber: 3,
          maxAttempts: 3,
          cancelRequestedAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
    }

    const result = await failAgentRunExecution(
      {
        tenantId: 'tenant-1',
        runId: 'run-1',
        leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        errorCode: 'TASK_EXECUTOR_FAILED',
        retryable: true,
      },
      client(transaction) as never,
    )

    expect(result.status).toBe('FAILED')
    expect(transaction.agentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: 'TASK_EXECUTOR_FAILED',
          errorMessage: 'Agent execution failed (TASK_EXECUTOR_FAILED).',
        }),
      }),
    )
    expect(transaction.agentTimelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          message: 'Agent execution failed (TASK_EXECUTOR_FAILED).',
        }),
      }),
    )
  })
})
