import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  question: vi.fn(),
  candidate: vi.fn(),
  promote: vi.fn(),
  founderDecision: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({ env: { AGENT_RUNNER_ENABLED: false } }))
vi.mock('@pathfinder/jobs', () => ({ enqueueAgentRun: vi.fn() }))
vi.mock('@pathfinder/db', () => ({
  AgentQuestionActionError: class AgentQuestionActionError extends Error {},
  FounderDecisionPacketActionError: class FounderDecisionPacketActionError extends Error {
    code = 'CONFLICT'
  },
  OnboardingQuestionActionError: class OnboardingQuestionActionError extends Error {},
  applyFounderDecisionPacketAction: mocks.founderDecision,
  answerAgentQuestionAction: vi.fn(),
  createClientOnboardingQuestionAction: vi.fn(),
  createCompanyKnowledgeCandidateAction: mocks.candidate,
  promoteCompanyKnowledgeAction: mocks.promote,
  withTenantIsolationBypass: mocks.bypass,
  db: {
    agentQuestion: { findFirst: mocks.question },
    venue: { findFirst: vi.fn() },
    tenantMembership: { findMany: vi.fn() },
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminAgentQuestionsRouter } from './agent-questions'

const testRouter = router({ questions: adminAgentQuestionsRouter })
const context: TRPCContext = {
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: {
    userId: 'operator_1',
    activeTenantId: null,
    role: null,
    isPlatformAdmin: true,
  },
}

describe('agent answer promotion', () => {
  beforeEach(() => vi.clearAllMocks())

  it('promotes an explicit human-classified answer without changing run-only answers', async () => {
    mocks.question.mockResolvedValue({
      id: 'question_1',
      question: 'What is the pricing rule?',
      answer: 'Custom characters use add-on pricing.',
      agentRunId: 'run_1',
    })
    mocks.candidate.mockResolvedValue({ id: 'knowledge_1', replayed: false })
    mocks.promote.mockResolvedValue({ id: 'knowledge_1', replayed: false })
    const result = await testRouter.createCaller(context).questions.promoteAgentAnswer({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      questionId: 'question_1',
      classification: 'STRATEGIC_DECISION',
      title: 'Custom character pricing',
      summary: 'Current add-on pricing rule.',
      rationale: 'Custom work has material production cost.',
      affectedSystems: ['billing'],
    })
    expect(result).toEqual({
      schemaVersion: 'agent-answer-promotion.v1',
      classification: 'STRATEGIC_DECISION',
      knowledgeItemId: 'knowledge_1',
      replayed: false,
    })
    expect(mocks.candidate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DECISION',
        accessScope: 'TENANT',
        authority: 'AUTHORITATIVE_CURRENT',
        sourceRef: 'agent-question:question_1',
        idempotencyKey: 'agent-answer:question_1:STRATEGIC_DECISION',
        decision: expect.objectContaining({ status: 'ACTIVE' }),
      }),
      expect.anything(),
    )
  })

  it('requires an organization for account-specific promotion', async () => {
    await expect(
      testRouter.createCaller(context).questions.promoteAgentAnswer({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        questionId: 'question_1',
        classification: 'DURABLE_PREFERENCE',
        title: 'Communication preference',
        summary: 'Prefers concise email.',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.question).not.toHaveBeenCalled()
  })

  it('promotes an explicitly classified human answer into exact founder current truth', async () => {
    const answeredAt = new Date('2026-08-22T18:30:00.000Z')
    mocks.question.mockResolvedValue({
      id: 'question_1',
      question: 'Should routine support require founder approval?',
      answer: 'Routine support should be handled autonomously within policy.',
      answeredAt,
      answeredById: 'operator_1',
      agentRunId: 'run_1',
    })
    mocks.founderDecision.mockResolvedValue({
      results: [
        {
          key: 'routine-support-authority',
          knowledgeItemId: 'knowledge_1',
          state: 'APPLIED',
          supersededKnowledgeItemId: null,
        },
      ],
    })

    const result = await testRouter
      .createCaller(context)
      .questions.promoteAgentAnswerToFounderDecision({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        questionId: 'question_1',
        decisionKey: 'routine-support-authority',
        title: 'Routine support authority',
        summary: 'Routine support does not need founder approval when policy permits it.',
        rationale: 'Founder attention should be reserved for consequential judgment.',
        affectedSystems: ['support', 'agent-policy'],
        scope: { appliesTo: 'torchiko-operations' },
      })

    expect(result).toEqual({
      schemaVersion: 'agent-answer-founder-decision-promotion.v1',
      decisionKey: 'routine-support-authority',
      knowledgeItemId: 'knowledge_1',
      state: 'APPLIED',
      supersededKnowledgeItemId: null,
      source: {
        questionId: 'question_1',
        agentRunId: 'run_1',
        answeredById: 'operator_1',
        answeredAt: answeredAt.toISOString(),
      },
    })
    expect(mocks.founderDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        packet: expect.objectContaining({
          schemaVersion: 'founder-decision-packet.v1',
          effectiveAt: answeredAt.toISOString(),
          sourceRef: 'agent-question:question_1',
          decisions: [
            expect.objectContaining({
              key: 'routine-support-authority',
              decision: 'Routine support should be handled autonomously within policy.',
              scope: { appliesTo: 'torchiko-operations' },
            }),
          ],
        }),
        actor: { type: 'HUMAN', actorId: 'operator_1', role: 'PLATFORM_ADMIN' },
      }),
      expect.anything(),
    )
  })

  it('refuses to promote an unanswered or non-human answer as founder policy', async () => {
    mocks.question.mockResolvedValue({
      id: 'question_1',
      question: 'What should happen?',
      answer: 'A machine-generated draft.',
      answeredAt: new Date('2026-08-22T18:30:00.000Z'),
      answeredById: null,
      agentRunId: 'run_1',
    })

    await expect(
      testRouter.createCaller(context).questions.promoteAgentAnswerToFounderDecision({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        questionId: 'question_1',
        decisionKey: 'unverified-policy',
        title: 'Unverified policy',
        summary: 'This must not be promoted.',
        rationale: 'There is no verified human answer.',
        scope: { appliesTo: 'torchiko-operations' },
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.founderDecision).not.toHaveBeenCalled()
  })

  it('requires the administrator who answered to explicitly promote the founder policy', async () => {
    mocks.question.mockResolvedValue({
      id: 'question_1',
      question: 'What should happen?',
      answer: 'Use the durable option.',
      answeredAt: new Date('2026-08-22T18:30:00.000Z'),
      answeredById: 'different_operator',
      agentRunId: 'run_1',
    })

    await expect(
      testRouter.createCaller(context).questions.promoteAgentAnswerToFounderDecision({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        questionId: 'question_1',
        decisionKey: 'durable-option',
        title: 'Durable option',
        summary: 'Use the durable option.',
        rationale: 'The answering administrator must explicitly promote it.',
        scope: { appliesTo: 'torchiko-operations' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.founderDecision).not.toHaveBeenCalled()
  })
})
