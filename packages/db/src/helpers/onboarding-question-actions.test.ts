import { describe, expect, it, vi } from 'vitest'

import {
  createClientOnboardingQuestionAction,
  resumeOnboardingQuestionFromSupportAction,
} from './onboarding-question-actions'

function client(transaction: Record<string, unknown>) {
  return {
    $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(transaction)),
  }
}

const operationId = '86d4ee39-a7c7-44ab-bf24-75c187cff002'
const updatedAt = new Date('2026-08-18T17:30:00.000Z')

function creationInput() {
  return {
    operationId,
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    agentQuestionId: 'question-1',
    expectedQuestionUpdatedAt: updatedAt,
    recipientUserId: 'client-1',
    category: 'ACCESSIBILITY' as const,
    subject: 'Accessible entrance details',
    why: 'This changes the arrival guidance shown to visitors.',
    whatWasFound: 'The website names an accessible entrance but not its public hours.',
    effect: 'The blocked accessibility review can continue.',
    actor: { actorId: 'admin-1', auditRole: 'PLATFORM_ADMIN' as const },
  }
}

describe('onboarding question coordination actions', () => {
  it('routes one exact blocked question to an active venue participant without granting approval', async () => {
    const link = {
      id: 'link-1',
      operationHash: 'a'.repeat(64),
      venueId: 'venue-1',
      agentQuestionId: 'question-1',
      supportRequestId: 'request-1',
      recipientUserId: 'client-1',
      resumedAt: null,
    }
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      onboardingQuestionLink: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
        create: vi.fn().mockResolvedValue(link),
      },
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'question-1',
          agentIdentityId: 'agent-1',
          agentRunId: 'run-1',
          question: 'Which entrance provides the step-free route?',
          blocking: true,
          status: 'PENDING',
          updatedAt,
          agentRun: { status: 'AWAITING_INPUT' },
        }),
      },
      tenantMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-1' }) },
      supportRequest: { create: vi.fn().mockResolvedValue({ id: 'request-1' }) },
      supportMessage: { create: vi.fn().mockResolvedValue({ id: 'message-1' }) },
      supportRequestAuditEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      supportRequestParticipant: { create: vi.fn().mockResolvedValue({ id: 'participant-1' }) },
      onboardingMilestoneEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }) => data),
      },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'timeline-1' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }

    const result = await createClientOnboardingQuestionAction(
      creationInput(),
      client(transaction) as never,
    )

    expect(result).toEqual({ link, replayed: false, approvalGranted: false })
    expect(transaction.supportRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'WAITING_FOR_CLIENT',
          createdByKind: 'OPERATOR',
          missingInformation: ['Which entrance provides the step-free route?'],
        }),
      }),
    )
    expect(transaction.supportRequestParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'client-1', grantedByKind: 'OPERATOR' }),
      }),
    )
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'onboarding-question.routed-to-client',
          afterState: expect.objectContaining({ approvalGranted: false }),
        }),
      }),
    )
    expect(transaction.onboardingMilestoneEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'QUESTION_ROUTED',
        sourceId: 'link-1',
        category: 'ACCESSIBILITY',
      }),
    })
  })

  it('rejects stale, non-blocking, or out-of-scope routing evidence', async () => {
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      onboardingQuestionLink: { findFirst: vi.fn().mockResolvedValue(null) },
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'question-1',
          agentIdentityId: 'agent-1',
          agentRunId: 'run-1',
          question: 'Question?',
          blocking: false,
          status: 'PENDING',
          updatedAt,
          agentRun: { status: 'AWAITING_INPUT' },
        }),
      },
      tenantMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-1' }) },
    }
    await expect(
      createClientOnboardingQuestionAction(creationInput(), client(transaction) as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('claims one exact client response and makes only its blocked run resumable', async () => {
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      onboardingQuestionLink: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'link-1',
          agentQuestionId: 'question-1',
          expectedQuestionUpdatedAt: updatedAt,
          answeredSupportMessageId: null,
          resumedAt: null,
          createdAt: new Date('2026-08-18T17:30:00.000Z'),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      supportMessage: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'message-2',
          body: 'The east entrance is step-free and open during every public hour.',
        }),
      },
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'question-1',
          agentIdentityId: 'agent-1',
          agentRunId: 'run-1',
          blocking: true,
          status: 'PENDING',
          updatedAt,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'timeline-1' }) },
      agentMessage: { create: vi.fn().mockResolvedValue({ id: 'agent-message-1' }) },
      onboardingMilestoneEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }) => data),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }

    const result = await resumeOnboardingQuestionFromSupportAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        supportRequestId: 'request-1',
        supportMessageId: 'message-2',
        actor: { actorId: 'client-1', auditRole: 'MANAGER' },
      },
      client(transaction) as never,
    )

    expect(result).toEqual({
      linked: true,
      replayed: false,
      runEligibleToResume: true,
      agentRunId: 'run-1',
      questionId: 'question-1',
    })
    expect(transaction.agentRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'run-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        status: 'AWAITING_INPUT',
      },
      data: { status: 'QUEUED' },
    })
    expect(transaction.agentMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: 'The east entrance is step-free and open during every public hour.',
        }),
      }),
    )
    expect(transaction.onboardingMilestoneEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'QUESTION_ANSWERED',
        sourceId: 'link-1',
        sourceRevision: 'message-2',
      }),
    })
  })

  it('returns a same-message replay for idempotent redispatch and rejects a stale answer claim', async () => {
    const replayTransaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      onboardingQuestionLink: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'link-1',
          agentQuestionId: 'question-1',
          expectedQuestionUpdatedAt: updatedAt,
          answeredSupportMessageId: 'message-2',
          resumedAt: new Date('2026-08-18T17:45:00.000Z'),
        }),
      },
      agentQuestion: { findFirst: vi.fn().mockResolvedValue({ agentRunId: 'run-1' }) },
    }
    const base = {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      supportRequestId: 'request-1',
      supportMessageId: 'message-2',
      actor: { actorId: 'client-1', auditRole: 'MANAGER' as const },
    }
    await expect(
      resumeOnboardingQuestionFromSupportAction(base, client(replayTransaction) as never),
    ).resolves.toMatchObject({ replayed: true, runEligibleToResume: true, agentRunId: 'run-1' })
    await expect(
      resumeOnboardingQuestionFromSupportAction(
        { ...base, supportMessageId: 'message-3' },
        client(replayTransaction) as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
