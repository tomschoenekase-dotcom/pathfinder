import { describe, expect, it, vi } from 'vitest'

import {
  claimAgentRunExecution,
  completeAgentRunExecution,
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
  questions: [],
  messages: [],
  workflowBindings: [],
}

function client(transaction: object) {
  return {
    $transaction: vi.fn(async (operation: (tx: unknown) => unknown) =>
      operation({
        agentWorkflowRunBinding: { findMany: vi.fn(async () => []) },
        $queryRaw: vi.fn(async (parts: readonly string[]) =>
          parts.join('').includes('clock_timestamp() AS now')
            ? [{ now: new Date(Date.now() - 1_000) }]
            : [
                {
                  venueId: baseRun.venueId,
                  agentIdentityId: baseRun.agentIdentityId,
                  attemptNumber: baseRun.attemptNumber,
                  maxAttempts: baseRun.maxAttempts,
                  cancelRequestedAt: baseRun.cancelRequestedAt,
                  executionLeaseExpiresAt: new Date(Date.now() + 60_000),
                },
              ],
        ),
        ...transaction,
      }),
    ),
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
      {
        tenantId: 'tenant-1',
        runId: 'run-1',
        leaseDurationMs: 60_000,
        bridgeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        executionWorkerId: 'worker-1',
      },
      client(transaction) as never,
    )
    expect(result.status).toBe('RUNNING')
    expect(result.attemptNumber).toBe(1)
    expect(JSON.parse(result.executionContext).provenance.attemptNumber).toBe(1)
    expect(result.executionPrompt).toContain('Bounded persisted execution context:')
    expect(result.leaseToken).toMatch(/^[0-9a-f-]{36}$/u)
    expect(transaction.agentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          attemptNumber: 0,
          agentIdentityId: 'agent-1',
          agentIdentity: { enabled: true },
          cancelRequestedAt: null,
        }),
        data: expect.objectContaining({
          status: 'RUNNING',
          attemptNumber: { increment: 1 },
          executionBridgeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          executionWorkerId: 'worker-1',
        }),
      }),
    )
    expect(transaction.agentRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1', tenantId: 'tenant-1' },
        select: expect.objectContaining({
          questions: expect.objectContaining({
            where: { status: 'ANSWERED' },
            take: 8,
            select: expect.objectContaining({
              discussionMessages: {
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: 6,
                select: { id: true, body: true, authorId: true, createdAt: true },
              },
            }),
          }),
          messages: expect.objectContaining({
            where: { messageType: { in: ['PROMPT', 'RESULT'] } },
            take: 12,
          }),
        }),
      }),
    )
  })

  it('includes a durable delegated result reference in a subsequent parent claim context', async () => {
    const callbackContent =
      'agent-run:child-1 completed. Untrusted delegated terminal result: Draft artifact is ready.'
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          ...baseRun,
          messages: [
            {
              id: 'callback-1',
              role: 'AGENT',
              messageType: 'RESULT',
              content: callbackContent,
              actorId: 'specialist-1',
              createdAt: new Date('2026-09-08T12:00:00.000Z'),
            },
          ],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
    }

    const claimed = await claimAgentRunExecution(
      { tenantId: 'tenant-1', runId: 'run-1' },
      client(transaction) as never,
    )

    expect(JSON.parse(claimed.executionContext).relevantMessages).toEqual([
      expect.objectContaining({
        messageType: 'RESULT',
        content: callbackContent,
        actorId: 'specialist-1',
      }),
    ])
    expect(claimed.executionPrompt).toContain('agent-run:child-1')
  })

  it('rejects complete workflow context over the caller budget before mutating the run', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          ...baseRun,
          workflowBindings: [
            {
              registryKey: 'review',
              outcome: 'SELECTED',
              bindingHash: 'b'.repeat(64),
              requiredCapabilities: ['knowledge.read'],
              workflowVersion: {
                id: 'version-1',
                contentHash: 'c'.repeat(64),
                portableText: 'Complete reviewed workflow text.',
              },
            },
          ],
        }),
        updateMany: vi.fn(),
      },
      agentTimelineEvent: { create: vi.fn() },
    }

    await expect(
      claimAgentRunExecution(
        {
          tenantId: 'tenant-1',
          runId: 'run-1',
          workflowContextMaxChars: 20,
        },
        client(transaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_CLAIMABLE' })
    expect(transaction.agentRun.updateMany).not.toHaveBeenCalled()
    expect(transaction.agentTimelineEvent.create).not.toHaveBeenCalled()
  })

  it('rejects a complete bridge prompt over budget before mutating the run', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          ...baseRun,
          requestPrompt: 'x'.repeat(1_900),
        }),
        updateMany: vi.fn(),
      },
      agentTimelineEvent: { create: vi.fn() },
    }

    await expect(
      claimAgentRunExecution(
        { tenantId: 'tenant-1', runId: 'run-1', executionPromptMaxChars: 100 },
        client(transaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_CLAIMABLE' })
    expect(transaction.agentRun.updateMany).not.toHaveBeenCalled()
  })

  it('commits a fenced cancellation before reporting the run as not claimable', async () => {
    const cancelRequestedAt = new Date('2026-09-08T03:00:00.000Z')
    let committed = false
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({ ...baseRun, cancelRequestedAt }),
        updateMany: vi.fn().mockImplementation(async ({ where }) => {
          expect(where).toMatchObject({
            id: 'run-1',
            tenantId: 'tenant-1',
            status: 'QUEUED',
            attemptNumber: 0,
            cancelRequestedAt,
          })
          committed = true
          return { count: 1 }
        }),
      },
      agentTimelineEvent: { create: vi.fn() },
    }
    const transactionalClient = {
      $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => {
        const result = await operation({
          agentWorkflowRunBinding: { findMany: vi.fn(async () => []) },
          $queryRaw: vi.fn(),
          ...transaction,
        })
        expect(committed).toBe(true)
        return result
      }),
    }

    await expect(
      claimAgentRunExecution(
        { tenantId: 'tenant-1', runId: 'run-1', workflowContextMaxChars: 1 },
        transactionalClient as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_CLAIMABLE' })
    expect(transaction.agentTimelineEvent.create).not.toHaveBeenCalled()
  })

  it('does not overwrite a concurrent completion when cancellation fencing loses', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          ...baseRun,
          cancelRequestedAt: new Date('2026-09-08T03:00:00.000Z'),
        }),
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
    expect(transaction.agentRun.updateMany).toHaveBeenCalledOnce()
  })

  it('fails the claim CAS when cancellation or identity disablement wins after the read', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue(baseRun),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      agentTimelineEvent: { create: vi.fn() },
    }

    await expect(
      claimAgentRunExecution(
        {
          tenantId: 'tenant-1',
          runId: 'run-1',
          bridgeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          executionWorkerId: 'worker-old',
        },
        client(transaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_CLAIMABLE' })

    expect(transaction.agentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          cancelRequestedAt: null,
          agentIdentity: { enabled: true },
        }),
      }),
    )
    expect(transaction.agentTimelineEvent.create).not.toHaveBeenCalled()
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

  it('keeps the winning worker binding when an older claimant resumes after the claim race', async () => {
    let releaseOlderUpdate!: () => void
    let notifyOlderUpdateStarted!: () => void
    const olderUpdateStarted = new Promise<void>((resolve) => {
      notifyOlderUpdateStarted = resolve
    })
    const olderMayResume = new Promise<void>((resolve) => {
      releaseOlderUpdate = resolve
    })
    const state = {
      attemptNumber: 0,
      workerId: null as string | null,
      bridgeSessionId: null as string | null,
    }
    let transactionNumber = 0
    const timelineCreate = vi.fn().mockResolvedValue({ id: 'event-1' })
    const racingClient = {
      $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => {
        transactionNumber += 1
        const thisTransaction = transactionNumber
        const observedAttempt = state.attemptNumber
        return operation({
          $queryRaw: vi.fn(async () => []),
          agentWorkflowRunBinding: { findMany: vi.fn(async () => []) },
          agentRun: {
            findFirst: vi.fn().mockResolvedValue({ ...baseRun, attemptNumber: observedAttempt }),
            updateMany: vi.fn(async (input: { where: { attemptNumber: number }; data: object }) => {
              if (thisTransaction === 1) {
                notifyOlderUpdateStarted()
                await olderMayResume
              }
              if (state.attemptNumber !== input.where.attemptNumber) return { count: 0 }
              state.attemptNumber += 1
              state.workerId = (
                input.data as { executionWorkerId: string | null }
              ).executionWorkerId
              state.bridgeSessionId = (
                input.data as { executionBridgeSessionId: string | null }
              ).executionBridgeSessionId
              return { count: 1 }
            }),
          },
          agentTimelineEvent: { create: timelineCreate },
        })
      }),
    }

    const olderClaim = claimAgentRunExecution(
      {
        tenantId: 'tenant-1',
        runId: 'run-1',
        bridgeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        executionWorkerId: 'worker-old',
      },
      racingClient as never,
    )
    await olderUpdateStarted
    const winningClaim = await claimAgentRunExecution(
      {
        tenantId: 'tenant-1',
        runId: 'run-1',
        bridgeSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        executionWorkerId: 'worker-current',
      },
      racingClient as never,
    )
    releaseOlderUpdate()

    await expect(olderClaim).rejects.toMatchObject({ code: 'NOT_CLAIMABLE' })
    expect(winningClaim.attemptNumber).toBe(1)
    expect(state).toEqual({
      attemptNumber: 1,
      workerId: 'worker-current',
      bridgeSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    })
    expect(timelineCreate).toHaveBeenCalledTimes(1)
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

  it('atomically records a delegated child result callback without mutating parent state', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const timelineCreate = vi.fn().mockResolvedValue({ id: 'event-1' })
    const messageCreate = vi.fn().mockResolvedValue({ id: 'message-1' })
    const transaction = {
      agentRun: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            venueId: 'venue-1',
            agentIdentityId: 'specialist-1',
            parentAgentRunId: 'parent-1',
            attemptNumber: 1,
            maxAttempts: 3,
            cancelRequestedAt: null,
          })
          .mockResolvedValueOnce({ id: 'parent-1' }),
        updateMany,
      },
      agentTimelineEvent: { create: timelineCreate },
      agentMessage: { create: messageCreate },
    }

    await expect(
      completeAgentRunExecution(
        {
          tenantId: 'tenant-1',
          runId: 'child-1',
          leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          summary: 'Draft artifact is ready.',
          artifacts: [{ kind: 'draft', id: 'artifact-1' }],
        },
        client(transaction) as never,
      ),
    ).resolves.toMatchObject({ status: 'COMPLETED' })

    expect(transaction.agentRun.findFirst).toHaveBeenNthCalledWith(2, {
      where: { id: 'parent-1', tenantId: 'tenant-1', venueId: 'venue-1' },
      select: { id: true },
    })
    expect(updateMany).toHaveBeenCalledOnce()
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'child-1' }) }),
    )
    expect(timelineCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentRunId: 'parent-1',
          eventType: 'DELEGATED_TASK_COMPLETED',
          data: {
            childAgentRunId: 'child-1',
            resultReference: 'agent-run:child-1',
            outcome: 'COMPLETED',
            artifactCount: 1,
          },
        }),
      }),
    )
    expect(messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentRunId: 'parent-1',
        agentIdentityId: 'specialist-1',
        messageType: 'RESULT',
        content:
          'agent-run:child-1 completed. Untrusted delegated terminal result: Draft artifact is ready.',
      }),
    })
  })

  it('does not write or complete when a delegated parent is missing from the exact scope', async () => {
    const updateMany = vi.fn()
    const timelineCreate = vi.fn()
    const messageCreate = vi.fn()
    const transaction = {
      agentRun: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            venueId: 'venue-1',
            agentIdentityId: 'specialist-1',
            parentAgentRunId: 'cross-scope-parent',
            attemptNumber: 1,
            maxAttempts: 3,
            cancelRequestedAt: null,
          })
          .mockResolvedValueOnce(null),
        updateMany,
      },
      agentTimelineEvent: { create: timelineCreate },
      agentMessage: { create: messageCreate },
    }

    await expect(
      completeAgentRunExecution(
        {
          tenantId: 'tenant-1',
          runId: 'child-1',
          leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          summary: 'Must not commit.',
        },
        client(transaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(updateMany).not.toHaveBeenCalled()
    expect(timelineCreate).not.toHaveBeenCalled()
    expect(messageCreate).not.toHaveBeenCalled()
  })

  it('does not write a delegated callback when the child completion CAS loses', async () => {
    const timelineCreate = vi.fn()
    const messageCreate = vi.fn()
    const transaction = {
      agentRun: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            venueId: 'venue-1',
            agentIdentityId: 'specialist-1',
            parentAgentRunId: 'parent-1',
            attemptNumber: 1,
            maxAttempts: 3,
            cancelRequestedAt: null,
          })
          .mockResolvedValueOnce({ id: 'parent-1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      agentTimelineEvent: { create: timelineCreate },
      agentMessage: { create: messageCreate },
    }

    await expect(
      completeAgentRunExecution(
        {
          tenantId: 'tenant-1',
          runId: 'child-1',
          leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          summary: 'Stale completion.',
        },
        client(transaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(timelineCreate).not.toHaveBeenCalled()
    expect(messageCreate).not.toHaveBeenCalled()
  })

  it('does not create a parent callback for a root run', async () => {
    const timelineCreate = vi.fn().mockResolvedValue({ id: 'event-1' })
    const messageCreate = vi.fn().mockResolvedValue({ id: 'message-1' })
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          venueId: 'venue-1',
          agentIdentityId: 'root-agent',
          parentAgentRunId: null,
          attemptNumber: 1,
          maxAttempts: 3,
          cancelRequestedAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentTimelineEvent: { create: timelineCreate },
      agentMessage: { create: messageCreate },
    }

    await completeAgentRunExecution(
      {
        tenantId: 'tenant-1',
        runId: 'root-1',
        leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        summary: 'Root completed.',
      },
      client(transaction) as never,
    )
    expect(timelineCreate).toHaveBeenCalledOnce()
    expect(messageCreate).toHaveBeenCalledOnce()
  })

  it('requeues a retryable failure while attempts remain and clears the lease', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          venueId: 'venue-1',
          agentIdentityId: 'specialist-1',
          parentAgentRunId: 'parent-1',
          attemptNumber: 1,
          maxAttempts: 3,
          cancelRequestedAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      agentMessage: { create: vi.fn() },
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
    expect(transaction.agentRun.findFirst).toHaveBeenCalledOnce()
    expect(transaction.agentTimelineEvent.create).toHaveBeenCalledOnce()
    expect(transaction.agentMessage.create).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'terminal failure',
      cancelRequestedAt: null,
      attemptNumber: 3,
      outcome: 'FAILED' as const,
      eventType: 'DELEGATED_TASK_FAILED',
      result: 'Agent execution failed (TASK_EXECUTOR_FAILED).',
    },
    {
      name: 'worker-finalized cancellation',
      cancelRequestedAt: new Date('2026-09-08T14:00:00.000Z'),
      attemptNumber: 1,
      outcome: 'CANCELLED' as const,
      eventType: 'DELEGATED_TASK_CANCELLED',
      result: 'The task was cancelled.',
    },
  ])('records exactly one parent result for a delegated $name', async (scenario) => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const timelineCreate = vi.fn().mockResolvedValue({ id: 'event-1' })
    const messageCreate = vi.fn().mockResolvedValue({ id: 'message-1' })
    const transaction = {
      agentRun: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            venueId: 'venue-1',
            agentIdentityId: 'specialist-1',
            parentAgentRunId: 'parent-1',
            attemptNumber: scenario.attemptNumber,
            maxAttempts: 3,
            cancelRequestedAt: scenario.cancelRequestedAt,
          })
          .mockResolvedValueOnce({ id: 'parent-1' }),
        updateMany,
      },
      agentTimelineEvent: { create: timelineCreate },
      agentMessage: { create: messageCreate },
    }

    await expect(
      failAgentRunExecution(
        {
          tenantId: 'tenant-1',
          runId: 'child-1',
          leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          errorCode: 'TASK_EXECUTOR_FAILED',
          retryable: true,
        },
        client(transaction) as never,
      ),
    ).resolves.toMatchObject({ status: scenario.outcome })

    expect(updateMany).toHaveBeenCalledOnce()
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'child-1' }) }),
    )
    expect(timelineCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentRunId: 'parent-1',
          eventType: scenario.eventType,
          data: {
            childAgentRunId: 'child-1',
            resultReference: 'agent-run:child-1',
            outcome: scenario.outcome,
          },
        }),
      }),
    )
    expect(messageCreate).toHaveBeenCalledOnce()
    expect(messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentRunId: 'parent-1',
        content: `agent-run:child-1 ${scenario.outcome.toLowerCase()}. Untrusted delegated terminal result: ${scenario.result}`,
      }),
    })
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

  it('finalizes cancellation without consulting expired workflow authority and denies completion', async () => {
    const bindingLookup = vi
      .fn()
      .mockResolvedValueOnce([{ registryKey: 'review', venueId: 'venue-1' }])
      .mockRejectedValue(new Error('workflow authority must not be consulted for cancellation'))
    const transaction = {
      agentWorkflowRunBinding: { findMany: bindingLookup },
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          venueId: 'venue-1',
          attemptNumber: 1,
          maxAttempts: 3,
          cancelRequestedAt: new Date(),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
    }
    await expect(
      failAgentRunExecution(
        {
          tenantId: 'tenant-1',
          runId: 'run-1',
          leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          errorCode: 'TASK_EXECUTOR_FAILED',
          retryable: false,
        },
        client(transaction) as never,
      ),
    ).resolves.toMatchObject({ status: 'CANCELLED' })
    expect(bindingLookup).toHaveBeenCalledTimes(1)

    const completionBindingLookup = vi
      .fn()
      .mockResolvedValueOnce([{ registryKey: 'review', venueId: 'venue-1' }])
      .mockRejectedValue(new Error('expired workflow authority denied'))
    await expect(
      completeAgentRunExecution(
        {
          tenantId: 'tenant-1',
          runId: 'run-1',
          leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          summary: 'Must not complete.',
        },
        client({
          ...transaction,
          agentWorkflowRunBinding: { findMany: completionBindingLookup },
        }) as never,
      ),
    ).rejects.toThrow('expired workflow authority denied')
  })

  it('rejects unknown uppercase failure codes before opening a transaction', async () => {
    const dbClient = client({})

    await expect(
      failAgentRunExecution(
        {
          tenantId: 'tenant-1',
          runId: 'run-1',
          leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          // Deliberately bypass the compile-time enum to prove the runtime boundary also fails closed.
          errorCode: 'UPSTREAM_SECRET_TOKEN' as never,
          retryable: true,
        },
        dbClient as never,
      ),
    ).rejects.toMatchObject({ name: 'ZodError' })
    expect(dbClient.$transaction).not.toHaveBeenCalled()
  })
})
