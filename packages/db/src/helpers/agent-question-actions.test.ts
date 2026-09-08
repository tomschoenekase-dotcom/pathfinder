import { describe, expect, it, vi } from 'vitest'

import { answerAgentQuestionAction, askAgentQuestionAction } from './agent-question-actions'

function client(transaction: Record<string, unknown>) {
  transaction.$queryRaw ??= vi.fn(async (parts: readonly string[]) =>
    parts.join('').includes('AS outstanding') ? [{ outstanding: false }] : [{ id: 'run-1' }],
  )
  transaction.$executeRaw ??= vi.fn().mockResolvedValue(1)
  transaction.agentQuestionOperation ??= {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
  }
  return {
    $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(transaction)),
  }
}

describe('agent question actions', () => {
  it('reconciles an exact lost answer acknowledgement without repeating side effects', async () => {
    const transaction = {
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'question-answered',
          agentRunId: 'run-1',
          agentIdentityId: 'agent-1',
          blocking: true,
          status: 'ANSWERED',
          answer: 'Use the north entrance.',
          answeredById: 'founder-1',
          updatedAt: new Date('2026-09-07T12:01:00.000Z'),
        }),
        updateMany: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
      },
      agentRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }),
      },
      agentTimelineEvent: { create: vi.fn() },
      agentMessage: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    }
    await expect(
      answerAgentQuestionAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          questionId: 'question-answered',
          expectedUpdatedAt: new Date('2026-09-07T12:00:00.000Z'),
          outcome: 'ANSWERED',
          answer: 'Use the north entrance.',
          actor: { actorType: 'HUMAN', actorId: 'founder-1', auditRole: 'PLATFORM_ADMIN' },
        },
        client(transaction) as never,
      ),
    ).resolves.toMatchObject({ replayed: true, questionId: 'question-answered' })
    expect(transaction.agentQuestion.updateMany).not.toHaveBeenCalled()
    expect(transaction.agentRun.updateMany).toHaveBeenCalledOnce()
    expect(transaction.agentRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'QUEUED', cancelRequestedAt: null }),
      }),
    )
    expect(transaction.agentTimelineEvent.create).not.toHaveBeenCalled()
    expect(transaction.agentMessage.create).not.toHaveBeenCalled()
    expect(transaction.auditLog.create).not.toHaveBeenCalled()
  })

  it.each(['COMPLETED', 'CANCELLED'] as const)(
    'does not claim a terminal %s run is resumable on replay',
    async () => {
      const transaction = {
        agentQuestion: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'question-answered',
            agentRunId: 'run-1',
            agentIdentityId: 'agent-1',
            blocking: true,
            status: 'ANSWERED',
            answer: 'North',
            answeredById: 'founder-1',
            updatedAt: new Date('2026-09-07T12:01:00.000Z'),
          }),
          count: vi.fn().mockResolvedValue(0),
        },
        agentRun: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findFirst: vi.fn().mockResolvedValue(null),
        },
      }
      await expect(
        answerAgentQuestionAction(
          {
            tenantId: 'tenant-1',
            venueId: 'venue-1',
            questionId: 'question-answered',
            expectedUpdatedAt: new Date('2026-09-07T12:00:00.000Z'),
            outcome: 'ANSWERED',
            answer: 'North',
            actor: { actorType: 'HUMAN', actorId: 'founder-1', auditRole: 'PLATFORM_ADMIN' },
          },
          client(transaction) as never,
        ),
      ).resolves.toMatchObject({
        replayed: true,
        runEligibleToResume: false,
      })
    },
  )

  it('rejects a duplicate response when answer or actor differs', async () => {
    const transaction = {
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'question-answered',
          agentRunId: null,
          agentIdentityId: 'agent-1',
          blocking: false,
          status: 'ANSWERED',
          answer: 'North',
          answeredById: 'founder-1',
          updatedAt: new Date('2026-09-07T12:01:00.000Z'),
        }),
      },
    }
    const base = {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      questionId: 'question-answered',
      expectedUpdatedAt: new Date('2026-09-07T12:00:00.000Z'),
      outcome: 'ANSWERED' as const,
      actor: {
        actorType: 'HUMAN' as const,
        actorId: 'founder-1',
        auditRole: 'PLATFORM_ADMIN' as const,
      },
    }
    await expect(
      answerAgentQuestionAction({ ...base, answer: 'South' }, client(transaction) as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      answerAgentQuestionAction(
        { ...base, answer: 'North', actor: { ...base.actor, actorId: 'other-founder' } },
        client(transaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('reconciles the exact concurrent winner after losing the pending CAS', async () => {
    const pending = {
      id: 'question-1',
      agentRunId: 'run-1',
      agentIdentityId: 'agent-1',
      blocking: true,
      status: 'PENDING',
      answer: null,
      answeredById: null,
      updatedAt: new Date('2026-09-07T12:00:00.000Z'),
    }
    const transaction = {
      agentQuestion: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(pending)
          .mockResolvedValueOnce({
            ...pending,
            status: 'ANSWERED',
            answer: 'North',
            answeredById: 'founder-1',
          }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn().mockResolvedValue(0),
      },
      agentRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }),
      },
    }
    await expect(
      answerAgentQuestionAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          questionId: 'question-1',
          expectedUpdatedAt: pending.updatedAt,
          outcome: 'ANSWERED',
          answer: 'North',
          actor: { actorType: 'HUMAN', actorId: 'founder-1', auditRole: 'PLATFORM_ADMIN' },
        },
        client(transaction) as never,
      ),
    ).resolves.toMatchObject({ replayed: true })
  })

  it('releases the interrupted execution owner when the final blocker queues the run', async () => {
    const pending = {
      id: 'question-final-blocker',
      agentRunId: 'run-1',
      agentIdentityId: 'agent-1',
      blocking: true,
      status: 'PENDING',
      answer: null,
      answeredById: null,
      updatedAt: new Date('2026-09-07T12:00:00.000Z'),
    }
    const updateRun = vi.fn().mockResolvedValue({ count: 1 })
    const transaction = {
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue(pending),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      agentRun: { updateMany: updateRun, findFirst: vi.fn() },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      agentMessage: { create: vi.fn().mockResolvedValue({ id: 'message-1' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }

    await expect(
      answerAgentQuestionAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          questionId: pending.id,
          expectedUpdatedAt: pending.updatedAt,
          outcome: 'ANSWERED',
          answer: 'Capacity is 137.',
          actor: { actorType: 'HUMAN', actorId: 'founder-1', auditRole: 'PLATFORM_ADMIN' },
        },
        client(transaction) as never,
      ),
    ).resolves.toMatchObject({ runEligibleToResume: true })
    expect(updateRun).toHaveBeenCalledWith({
      where: {
        id: 'run-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        status: 'AWAITING_INPUT',
        cancelRequestedAt: null,
      },
      data: {
        status: 'QUEUED',
        executionBridgeSessionId: null,
        executionWorkerId: null,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
        lastHeartbeatAt: null,
      },
    })
  })

  it('retains the execution owner while another blocking question remains', async () => {
    const pending = {
      id: 'question-one-of-two',
      agentRunId: 'run-1',
      agentIdentityId: 'agent-1',
      blocking: true,
      status: 'PENDING',
      answer: null,
      answeredById: null,
      updatedAt: new Date('2026-09-07T12:00:00.000Z'),
    }
    const updateRun = vi.fn()
    const transaction = {
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue(pending),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(1),
      },
      agentRun: { updateMany: updateRun },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      agentMessage: { create: vi.fn().mockResolvedValue({ id: 'message-1' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }

    await expect(
      answerAgentQuestionAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          questionId: pending.id,
          expectedUpdatedAt: pending.updatedAt,
          outcome: 'ANSWERED',
          answer: 'Capacity is 137.',
          actor: { actorType: 'HUMAN', actorId: 'founder-1', auditRole: 'PLATFORM_ADMIN' },
        },
        client(transaction) as never,
      ),
    ).resolves.toMatchObject({ runEligibleToResume: false })
    expect(updateRun).not.toHaveBeenCalled()
  })

  it('does not queue an answered parent while a delegated dependency is still outstanding', async () => {
    const pending = {
      id: 'question-before-child',
      agentRunId: 'run-1',
      agentIdentityId: 'agent-1',
      blocking: true,
      status: 'PENDING',
      answer: null,
      answeredById: null,
      updatedAt: new Date('2026-09-07T12:00:00.000Z'),
    }
    const updateRun = vi.fn()
    const transaction = {
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue(pending),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      agentRun: { updateMany: updateRun },
      $queryRaw: vi.fn(async (parts: readonly string[]) =>
        parts.join('').includes('AS outstanding') ? [{ outstanding: true }] : [{ id: 'run-1' }],
      ),
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      agentMessage: { create: vi.fn().mockResolvedValue({ id: 'message-1' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }

    await expect(
      answerAgentQuestionAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          questionId: pending.id,
          expectedUpdatedAt: pending.updatedAt,
          outcome: 'ANSWERED',
          answer: 'Answer arrived before the specialist result.',
          actor: { actorType: 'HUMAN', actorId: 'founder-1', auditRole: 'PLATFORM_ADMIN' },
        },
        client(transaction) as never,
      ),
    ).resolves.toMatchObject({ runEligibleToResume: false })
    expect(updateRun).not.toHaveBeenCalled()
  })
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
    expect(result).toEqual({ question: created, replayed: false, consolidated: false })
    expect(transaction.agentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'AWAITING_INPUT' } }),
    )
  })

  it('aliases an exact pending question in the same active run without duplicate side effects', async () => {
    const duplicate = {
      id: 'question-existing',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      question: 'Which source is authoritative?',
      context: null,
      questionType: 'SHORT_TEXT',
      category: 'general',
      urgency: 'NORMAL',
      dueAt: null,
      expiresAt: null,
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
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(duplicate),
        create: vi.fn(),
      },
      agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent-1' }) },
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }),
        updateMany: vi.fn(),
      },
      agentTimelineEvent: { create: vi.fn() },
      agentMessage: { create: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }
    const operationId = '96d4ee39-a7c7-44ab-bf24-75c187cff002'
    const scopedClient = client(transaction)

    await expect(
      askAgentQuestionAction(
        {
          operationId,
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          agentIdentityId: 'agent-1',
          agentRunId: 'run-1',
          question: duplicate.question,
        },
        scopedClient as never,
      ),
    ).resolves.toEqual({ question: duplicate, replayed: false, consolidated: true })
    expect(transaction.agentQuestion.create).not.toHaveBeenCalled()
    expect(transaction.agentRun.updateMany).not.toHaveBeenCalled()
    expect(transaction.agentTimelineEvent.create).not.toHaveBeenCalled()
    expect(transaction.agentMessage.create).not.toHaveBeenCalled()
    expect(
      (
        transaction as typeof transaction & {
          agentQuestionOperation: { create: ReturnType<typeof vi.fn> }
        }
      ).agentQuestionOperation.create,
    ).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        operationId,
        venueId: 'venue-1',
        questionId: duplicate.id,
      },
    })
    expect(transaction.auditLog.create).toHaveBeenCalledOnce()
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

  it('replays JSONB-reordered rich evidence while still rejecting changed values and array order', async () => {
    const existing = {
      id: 'question-1',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      agentRunId: null,
      question: 'Which hours?',
      context: null,
      questionType: 'SHORT_TEXT',
      category: 'general',
      urgency: 'NORMAL',
      dueAt: null,
      blocking: false,
      choices: [],
      evidence: [
        { reference: 'source-a', summary: 'Open at 9', label: 'A' },
        { reference: 'source-b', label: 'B' },
      ],
      callbackMetadata: { target: 'hours', blockerScope: 'LOCAL' },
      proposedAnswer: {
        candidateEntities: [{ reference: 'entry', label: 'Entrance' }],
        confidence: 0.5,
      },
    }
    const transaction = {
      agentQuestion: { findFirst: vi.fn().mockResolvedValue(existing), create: vi.fn() },
    }
    const input = {
      operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      question: 'Which hours?',
      blocking: false,
      evidence: [
        { label: 'A', reference: 'source-a', summary: 'Open at 9' },
        { label: 'B', reference: 'source-b' },
      ],
      callbackMetadata: { blockerScope: 'LOCAL', target: 'hours' },
      proposedAnswer: {
        confidence: 0.5,
        candidateEntities: [{ label: 'Entrance', reference: 'entry' }],
      },
    }
    expect((await askAgentQuestionAction(input, client(transaction) as never)).replayed).toBe(true)
    for (const changed of [
      { ...input, evidence: [...input.evidence].reverse() },
      { ...input, callbackMetadata: { ...input.callbackMetadata, target: 'entrance' } },
      { ...input, proposedAnswer: { ...input.proposedAnswer, confidence: 0.9 } },
    ])
      await expect(
        askAgentQuestionAction(changed, client(transaction) as never),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
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
