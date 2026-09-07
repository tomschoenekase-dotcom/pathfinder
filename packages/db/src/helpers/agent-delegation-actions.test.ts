import { beforeEach, describe, expect, it, vi } from 'vitest'
const workflowMocks = vi.hoisted(() => ({
  bind: vi.fn(async () => ({ bindings: [], replayed: false })),
  lock: vi.fn(async (_tx, input: { registryKeys: string[] }) => [...input.registryKeys].sort()),
  resolve: vi.fn(async () => [] as string[]),
  guard: vi.fn(async () => ({ bindings: [] })),
}))
vi.mock('./agent-workflow-run-binding', () => ({
  bindAgentWorkflowVersions: workflowMocks.bind,
  lockAgentWorkflowActivationHeads: workflowMocks.lock,
  resolveActiveAgentWorkflowRegistryKeys: workflowMocks.resolve,
}))
vi.mock('./agent-workflow-run-lease', () => ({
  assertEligibleWorkflowRunLease: workflowMocks.guard,
}))

import { delegateAgentTaskAction } from './agent-delegation-actions'

describe('agent delegation action', () => {
  const input = {
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    parentAgentRunId: 'parent-1',
    requestingAgentIdentityId: 'primary-1',
    specialistAgentIdentityId: 'specialist-1',
    instructions: 'Research the architecture.',
    reason: 'This specialist owns evaluation architecture.',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    workflowMocks.resolve.mockResolvedValue([])
    workflowMocks.bind.mockResolvedValue({ bindings: [], replayed: false })
    workflowMocks.guard.mockResolvedValue({ bindings: [] })
  })

  it('creates an idempotent child run from an active exact-scope parent and enabled specialist', async () => {
    workflowMocks.resolve.mockResolvedValue(['alpha', 'zeta'])
    const transaction = {
      $executeRaw: vi.fn(),
      agentRun: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'parent-1', agentIdentityId: 'primary-1' }),
        create: vi.fn().mockResolvedValue({
          id: 'child-1',
          parentAgentRunId: 'parent-1',
          agentIdentityId: 'specialist-1',
          requestPrompt: 'Research the architecture.',
          status: 'QUEUED',
          createdAt: new Date(),
        }),
      },
      agentIdentity: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'specialist-1',
          agentType: 'EVALUATION',
          accessScope: 'VENUE',
          accessCapabilities: ['evaluation.read'],
          autonomyLevel: 'READ_ONLY',
          autonomousActions: [],
          defaultProvider: 'anthropic',
          defaultModel: 'central:agent-run',
        }),
      },
      agentWorkflowRunBinding: { findMany: vi.fn().mockResolvedValue([]) },
      agentTimelineEvent: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      agentMessage: { create: vi.fn().mockResolvedValue({ id: 'message-1' }) },
    }
    const client = {
      $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(transaction)),
    }
    const result = await delegateAgentTaskAction(input, client as never)
    expect(result.run.id).toBe('child-1')
    expect(transaction.agentRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parentAgentRunId: 'parent-1',
          initiatedByType: 'AGENT',
          initiatedById: 'primary-1',
          status: 'QUEUED',
        }),
      }),
    )
    expect(transaction.agentTimelineEvent.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ agentRunId: 'parent-1', eventType: 'SPECIALIST_DELEGATED' }),
        expect.objectContaining({ agentRunId: 'child-1', eventType: 'DELEGATED_TASK_QUEUED' }),
      ]),
    })
    expect(workflowMocks.bind).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ registryKeys: ['alpha', 'zeta'] }),
    )
  })

  it('requires the exact lease before a workflow-bound parent can delegate', async () => {
    workflowMocks.resolve.mockResolvedValue(['child-key'])
    const transaction = {
      $executeRaw: vi.fn(),
      agentRun: { findFirst: vi.fn().mockResolvedValueOnce(null) },
      agentWorkflowRunBinding: {
        findMany: vi.fn().mockResolvedValue([{ registryKey: 'parent-key', outcome: 'SELECTED' }]),
      },
    }
    const client = {
      $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(transaction)),
    }
    await expect(delegateAgentTaskAction(input, client as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Workflow-bound delegation requires the exact execution lease token',
    })
    expect(workflowMocks.lock).toHaveBeenCalledWith(transaction, {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      registryKeys: ['parent-key', 'child-key'],
      maxKeys: 100,
    })
    expect(workflowMocks.guard).not.toHaveBeenCalled()
  })

  it('locks the union, guards the parent, creates the child, then binds the captured keys', async () => {
    workflowMocks.resolve.mockResolvedValue(['child-key'])
    const transaction = {
      $executeRaw: vi.fn(),
      agentRun: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'parent-1', agentIdentityId: 'primary-1' }),
        create: vi.fn().mockResolvedValue({
          id: 'child-1',
          parentAgentRunId: 'parent-1',
          agentIdentityId: 'specialist-1',
          requestPrompt: 'Research the architecture.',
          status: 'QUEUED',
          createdAt: new Date(),
        }),
      },
      agentWorkflowRunBinding: {
        findMany: vi.fn().mockResolvedValue([{ registryKey: 'parent-key', outcome: 'SELECTED' }]),
      },
      agentIdentity: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'specialist-1',
          agentType: 'EVALUATION',
          accessScope: 'VENUE',
          accessCapabilities: [],
          autonomyLevel: 'READ_ONLY',
          autonomousActions: [],
          defaultProvider: 'deterministic',
          defaultModel: 'fixture',
        }),
      },
      agentTimelineEvent: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      agentMessage: { create: vi.fn().mockResolvedValue({ id: 'message-1' }) },
    }
    const client = {
      $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(transaction)),
    }
    await expect(
      delegateAgentTaskAction(
        { ...input, executionLeaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        client as never,
      ),
    ).resolves.toMatchObject({ run: { id: 'child-1' }, replayed: false })
    expect(workflowMocks.guard).toHaveBeenCalledWith(transaction, {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentRunId: 'parent-1',
      executionLeaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      actionClass: 'AGENT_DELEGATION',
    })
    expect(workflowMocks.resolve).toHaveBeenCalledTimes(1)
    expect(workflowMocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      workflowMocks.guard.mock.invocationCallOrder[0]!,
    )
    expect(workflowMocks.guard.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.agentRun.create.mock.invocationCallOrder[0]!,
    )
    expect(transaction.agentRun.create.mock.invocationCallOrder[0]).toBeLessThan(
      workflowMocks.bind.mock.invocationCallOrder[0]!,
    )
    expect(workflowMocks.bind).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ registryKeys: ['child-key'] }),
    )
  })

  it.each(['LEASE_LOST', 'REVOKED', 'UNSUPPORTED_ACTION'])(
    'does not create child work when canonical admission rejects with %s',
    async (code) => {
      workflowMocks.resolve.mockResolvedValue(['child-key'])
      workflowMocks.guard.mockRejectedValueOnce(Object.assign(new Error(code), { code }))
      const transaction = {
        $executeRaw: vi.fn(),
        agentRun: { findFirst: vi.fn().mockResolvedValueOnce(null), create: vi.fn() },
        agentWorkflowRunBinding: {
          findMany: vi.fn().mockResolvedValue([{ registryKey: 'parent-key', outcome: 'SELECTED' }]),
        },
        agentIdentity: { findFirst: vi.fn() },
        agentTimelineEvent: { createMany: vi.fn() },
        agentMessage: { create: vi.fn() },
      }
      const client = {
        $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(transaction)),
      }
      await expect(
        delegateAgentTaskAction(
          { ...input, executionLeaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
          client as never,
        ),
      ).rejects.toMatchObject({ code })
      expect(transaction.agentRun.create).not.toHaveBeenCalled()
      expect(workflowMocks.bind).not.toHaveBeenCalled()
      expect(transaction.agentTimelineEvent.createMany).not.toHaveBeenCalled()
      expect(transaction.agentMessage.create).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['a different venue', { venueId: 'venue-2' }],
    ['a different requesting identity', { requestingAgentIdentityId: 'primary-2' }],
  ])('rejects operation replay from %s', async (_label, override) => {
    const transaction = {
      $executeRaw: vi.fn(),
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'child-1',
          venueId: 'venue-1',
          parentAgentRunId: 'parent-1',
          agentIdentityId: 'specialist-1',
          initiatedByType: 'AGENT',
          initiatedById: 'primary-1',
          requestPrompt: 'Research the architecture.',
          status: 'QUEUED',
          createdAt: new Date(),
        }),
      },
    }
    const client = {
      $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(transaction)),
    }

    await expect(
      delegateAgentTaskAction({ ...input, ...override }, client as never),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Delegation operation was already used for different work',
    })
    expect(transaction.agentRun.findFirst).toHaveBeenCalledTimes(1)
  })

  it('replays the exact stored venue and requesting identity without requiring the parent to remain active', async () => {
    const replay = {
      id: 'child-1',
      venueId: 'venue-1',
      parentAgentRunId: 'parent-1',
      agentIdentityId: 'specialist-1',
      initiatedByType: 'AGENT',
      initiatedById: 'primary-1',
      requestPrompt: 'Research the architecture.',
      status: 'COMPLETED',
      createdAt: new Date(),
    }
    const transaction = {
      $executeRaw: vi.fn(),
      agentRun: { findFirst: vi.fn().mockResolvedValue(replay) },
    }
    const client = {
      $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(transaction)),
    }

    await expect(delegateAgentTaskAction(input, client as never)).resolves.toEqual({
      run: replay,
      replayed: true,
    })
    expect(transaction.$executeRaw).toHaveBeenCalledOnce()
    expect(transaction.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.agentRun.findFirst.mock.invocationCallOrder[0]!,
    )
    expect(transaction.agentRun.findFirst).toHaveBeenCalledTimes(1)
  })
})
