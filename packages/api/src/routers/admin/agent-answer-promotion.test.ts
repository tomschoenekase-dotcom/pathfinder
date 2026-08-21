import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  question: vi.fn(),
  candidate: vi.fn(),
  promote: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({ env: { AGENT_RUNNER_ENABLED: false } }))
vi.mock('@pathfinder/jobs', () => ({ enqueueAgentRun: vi.fn() }))
vi.mock('@pathfinder/db', () => ({
  AgentQuestionActionError: class AgentQuestionActionError extends Error {},
  OnboardingQuestionActionError: class OnboardingQuestionActionError extends Error {},
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
})
