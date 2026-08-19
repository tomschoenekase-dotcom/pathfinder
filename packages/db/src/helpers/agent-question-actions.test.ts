import { describe, expect, it, vi } from 'vitest'

import { askAgentQuestionAction } from './agent-question-actions'

function client(transaction: Record<string, unknown>) {
  return {
    $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(transaction)),
  }
}

describe('agent question actions', () => {
  it('creates an idempotent blocking question and pauses the exact active run', async () => {
    const created = {
      id: 'question-1',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      question: 'Which source is authoritative?',
      context: null,
      choices: ['Website', 'Operator note'],
      blocking: true,
      status: 'PENDING',
      answer: null,
      updatedAt: new Date('2026-08-18T17:30:00Z'),
    }
    const transaction = {
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
      },
      agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent-1' }) },
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      agentMessage: { create: vi.fn().mockResolvedValue({ id: 'message-1' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }
    const result = await askAgentQuestionAction(
      {
        operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        question: created.question,
        choices: created.choices,
        blocking: true,
      },
      client(transaction) as never,
    )
    expect(result).toEqual({ question: created, replayed: false })
    expect(transaction.agentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'AWAITING_INPUT' } }),
    )
  })

  it('returns a same-operation replay without creating duplicate state', async () => {
    const existing = {
      id: 'question-1',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      agentRunId: null,
      question: 'Continue?',
      context: null,
      choices: [],
      blocking: true,
      status: 'PENDING',
      answer: null,
      updatedAt: new Date('2026-08-18T17:30:00Z'),
    }
    const transaction = {
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
      },
    }
    const result = await askAgentQuestionAction(
      {
        operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentIdentityId: 'agent-1',
        question: 'Continue?',
      },
      client(transaction) as never,
    )
    expect(result.replayed).toBe(true)
    expect(transaction.agentQuestion.create).not.toHaveBeenCalled()
  })
})
