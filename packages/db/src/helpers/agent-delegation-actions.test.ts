import { describe, expect, it, vi } from 'vitest'
vi.mock('./agent-workflow-run-binding', () => ({
  bindEligibleAgentWorkflows: vi.fn(async () => ({ bindings: [], replayed: false })),
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

  it('creates an idempotent child run from an active exact-scope parent and enabled specialist', async () => {
    const transaction = {
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
  })

  it.each([
    ['a different venue', { venueId: 'venue-2' }],
    ['a different requesting identity', { requestingAgentIdentityId: 'primary-2' }],
  ])('rejects operation replay from %s', async (_label, override) => {
    const transaction = {
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
    const transaction = { agentRun: { findFirst: vi.fn().mockResolvedValue(replay) } }
    const client = {
      $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(transaction)),
    }

    await expect(delegateAgentTaskAction(input, client as never)).resolves.toEqual({
      run: replay,
      replayed: true,
    })
    expect(transaction.agentRun.findFirst).toHaveBeenCalledTimes(1)
  })
})
