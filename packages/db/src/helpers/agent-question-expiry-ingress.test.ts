import { beforeEach, describe, expect, it, vi } from 'vitest'

const expire = vi.hoisted(() => vi.fn())
vi.mock('./agent-question-expiration-actions', () => ({ expireAgentQuestionIfDue: expire }))

import { answerAgentQuestionAction } from './agent-question-actions'
import {
  createClientOnboardingQuestionAction,
  resumeOnboardingQuestionFromSupportAction,
} from './onboarding-question-actions'

const at = new Date('2026-09-08T12:00:00Z')
const scope = { tenantId: 'tenant-1', venueId: 'venue-1' }
const actor = {
  actorType: 'HUMAN' as const,
  actorId: 'admin-1',
  auditRole: 'PLATFORM_ADMIN' as const,
}
function harness() {
  const events: string[] = []
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'run-1' }]),
    agentQuestion: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'question-1',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        blocking: true,
        status: 'PENDING',
        expiresAt: at,
        updatedAt: at,
        agentRun: { status: 'AWAITING_INPUT' },
      }),
      updateMany: vi.fn(),
    },
    onboardingQuestionLink: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn() },
    tenantMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'member-1' }) },
    supportRequest: { create: vi.fn() },
    supportMessage: {
      findFirst: vi.fn().mockResolvedValue({ id: 'message-1', body: 'Durable late reply.' }),
    },
  }
  const client = {
    $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => {
      try {
        const result = await operation(tx)
        events.push('commit')
        return result
      } catch (error) {
        events.push('rollback')
        throw error
      }
    }),
  }
  return { tx, client, events }
}
describe('question expiry ingress transaction boundaries', () => {
  beforeEach(() => {
    expire.mockReset()
    expire.mockResolvedValue('EXPIRED')
  })
  it('commits expiration before reporting a rejected founder answer', async () => {
    const h = harness()
    await expect(
      answerAgentQuestionAction(
        {
          ...scope,
          questionId: 'question-1',
          expectedUpdatedAt: at,
          outcome: 'ANSWERED',
          answer: 'Late answer.',
          actor,
        },
        h.client as never,
      ),
    ).rejects.toMatchObject({ code: 'EXPIRED' })
    expect(h.events).toEqual(['commit'])
    expect(h.tx.agentQuestion.updateMany).not.toHaveBeenCalled()
  })
  it('recovers a SQL cutoff race in a new committed expiration transaction', async () => {
    const h = harness()
    expire.mockResolvedValueOnce('NOT_DUE').mockResolvedValueOnce('EXPIRED')
    h.tx.agentQuestion.updateMany.mockRejectedValue(
      new Error('agent question answer deadline has expired'),
    )
    await expect(
      answerAgentQuestionAction(
        {
          ...scope,
          questionId: 'question-1',
          expectedUpdatedAt: at,
          outcome: 'ANSWERED',
          answer: 'Racing answer.',
          actor,
        },
        h.client as never,
      ),
    ).rejects.toMatchObject({ code: 'EXPIRED' })
    expect(h.events).toEqual(['rollback', 'commit'])
    expect(expire).toHaveBeenCalledTimes(2)
  })
  it('commits expiration without creating a client support request', async () => {
    const h = harness()
    await expect(
      createClientOnboardingQuestionAction(
        {
          ...scope,
          operationId: '00000000-0000-4000-8000-000000000001',
          agentQuestionId: 'question-1',
          expectedQuestionUpdatedAt: at,
          recipientUserId: 'client-1',
          category: 'GENERAL',
          subject: 'Confirm entrance',
          why: 'Sources differ.',
          effect: 'Continue review.',
          actor: { actorId: actor.actorId, auditRole: 'PLATFORM_ADMIN' },
        },
        h.client as never,
      ),
    ).rejects.toMatchObject({ code: 'EXPIRED' })
    expect(h.events).toEqual(['commit'])
    expect(h.tx.supportRequest.create).not.toHaveBeenCalled()
  })
  it('returns saved late-reply context without claiming an answer or run resumption', async () => {
    const h = harness()
    h.tx.onboardingQuestionLink.findFirst.mockResolvedValue({
      id: 'link-1',
      agentQuestionId: 'question-1',
      expectedQuestionUpdatedAt: at,
      answeredSupportMessageId: null,
      resumedAt: null,
    })
    await expect(
      resumeOnboardingQuestionFromSupportAction(
        {
          ...scope,
          supportRequestId: 'request-1',
          supportMessageId: 'message-1',
          actor: { actorId: 'client-1', auditRole: 'MANAGER' },
        },
        h.client as never,
      ),
    ).resolves.toMatchObject({
      linked: true,
      questionExpired: true,
      runEligibleToResume: false,
    })
    expect(h.events).toEqual(['commit'])
    expect(h.tx.agentQuestion.updateMany).not.toHaveBeenCalled()
    expect(h.tx.onboardingQuestionLink.updateMany).not.toHaveBeenCalled()
  })
})
