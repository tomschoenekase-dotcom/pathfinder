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
      questionType: 'SHORT_TEXT',
      category: 'general',
      urgency: 'NORMAL',
      dueAt: null,
      evidence: [],
      proposedAnswer: null,
      callbackMetadata: null,
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
      questionType: 'SHORT_TEXT',
      category: 'general',
      urgency: 'NORMAL',
      dueAt: null,
      evidence: [],
      proposedAnswer: null,
      callbackMetadata: null,
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

  it('persists bounded rich evidence and decision support in the canonical question', async () => {
    const created = {
      id: 'question-rich',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      agentRunId: null,
      question: 'Which entrance should visitors use?',
      context: null,
      questionType: 'SHORT_TEXT',
      category: 'general',
      urgency: 'NORMAL',
      dueAt: null,
      evidence: [],
      proposedAnswer: null,
      callbackMetadata: null,
      choices: [],
      blocking: false,
      status: 'PENDING',
      answer: null,
      updatedAt: new Date('2026-08-29T17:30:00Z'),
    }
    const transaction = {
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
      },
      agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent-1' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }
    const evidence = [
      {
        label: 'Walkthrough entrance sequence',
        reference: 'https://example.com/walkthrough.mp4',
        summary: 'The guide points visitors to the north doors.',
        kind: 'VIDEO_TIMESTAMP' as const,
        timestampSeconds: 94,
      },
    ]
    const proposedAnswer = {
      interpretation: 'Use the north entrance',
      confidence: 0.82,
      candidateEntities: [
        {
          label: 'North entrance',
          entityType: 'entrance',
          reference: 'venue-entity:north-entrance',
        },
      ],
      answerConsequences: [
        {
          answer: 'North entrance',
          consequence: 'Visitor directions use the accessible north path.',
        },
        { answer: 'South entrance', consequence: 'The proposed north path remains excluded.' },
      ],
    }

    await askAgentQuestionAction(
      {
        operationId: '3a4d1053-9239-42e1-a4cc-a3caeaf29c4c',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentIdentityId: 'agent-1',
        question: created.question,
        evidence,
        proposedAnswer,
        blocking: false,
      },
      client(transaction) as never,
    )

    expect(transaction.agentQuestion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ evidence, proposedAnswer }),
      }),
    )
  })

  it('rejects timestamps that are not attached to video evidence', async () => {
    await expect(
      askAgentQuestionAction(
        {
          operationId: '3a4d1053-9239-42e1-a4cc-a3caeaf29c4c',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          agentIdentityId: 'agent-1',
          question: 'Which map is current?',
          evidence: [
            {
              label: 'Campus map',
              reference: 'https://example.com/map',
              kind: 'MAP',
              timestampSeconds: 45,
            },
          ],
        },
        client({}) as never,
      ),
    ).rejects.toThrow('Evidence timestamps require VIDEO_TIMESTAMP kind.')
  })

  it('serializes file clarifications with terminal review and revalidates the exact receipt', async () => {
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      intakeFileExtractionReceipt: { findFirst: vi.fn().mockResolvedValue(null) },
      agentQuestion: { findFirst: vi.fn(), create: vi.fn() },
    }

    await expect(
      askAgentQuestionAction(
        {
          operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          agentIdentityId: 'agent-1',
          question: 'Which entrance is authoritative?',
          category: 'builder-file-clarification',
          callbackMetadata: {
            workflow: 'intake-file-extraction-clarification',
            runId: 'run-file',
            receiptId: '975140d8-5af9-4c2d-9132-40b5cf6f5962',
            extractedTextHash: 'a'.repeat(64),
          },
        },
        client(transaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(transaction.$executeRaw).toHaveBeenCalledOnce()
    expect(transaction.intakeFileExtractionReceipt.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        runId: 'run-file',
        extractedTextHash: 'a'.repeat(64),
        review: { is: null },
      }),
      select: { id: true },
    })
    expect(transaction.agentQuestion.findFirst).not.toHaveBeenCalled()
  })
})
