import { describe, expect, it, vi } from 'vitest'

import { createAgentTaskAction } from './agent-task-actions'

describe('agent task action', () => {
  it('freezes enabled specialist scope into a queued run without execution', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'run-1',
          venueId: 'venue-1',
          agentIdentityId: 'agent-1',
          requestPrompt: 'Research this issue.',
          status: 'QUEUED',
          createdAt: new Date('2026-08-18T17:30:00Z'),
        }),
      },
      agentIdentity: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'agent-1',
          agentType: 'OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['operations.read'],
          autonomyLevel: 'READ_ONLY',
          autonomousActions: [],
          defaultProvider: 'provider',
          defaultModel: 'model',
        }),
      },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      agentMessage: { create: vi.fn().mockResolvedValue({ id: 'message-1' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }
    const client = {
      $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(transaction)),
    }
    const result = await createAgentTaskAction(
      {
        operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentIdentityId: 'agent-1',
        prompt: 'Research this issue.',
        actor: { actorType: 'HUMAN', actorId: 'admin-1', auditRole: 'PLATFORM_ADMIN' },
      },
      client as never,
    )
    expect(result.executionTriggered).toBe(false)
    expect(transaction.agentRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'QUEUED', requestPrompt: 'Research this issue.' }),
      }),
    )
  })
})
