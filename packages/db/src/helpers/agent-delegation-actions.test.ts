import { describe, expect, it, vi } from 'vitest'

import { delegateAgentTaskAction } from './agent-delegation-actions'

describe('agent delegation action', () => {
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
    const result = await delegateAgentTaskAction(
      {
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        parentAgentRunId: 'parent-1',
        requestingAgentIdentityId: 'primary-1',
        specialistAgentIdentityId: 'specialist-1',
        instructions: 'Research the architecture.',
        reason: 'This specialist owns evaluation architecture.',
      },
      client as never,
    )
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
})
