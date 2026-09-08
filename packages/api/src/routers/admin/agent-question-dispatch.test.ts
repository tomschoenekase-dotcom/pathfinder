import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  enabled: { AGENT_RUNNER_ENABLED: true },
  answer: vi.fn(),
  enqueue: vi.fn(),
  warn: vi.fn(),
}))
vi.mock('@pathfinder/config', () => ({ env: mocks.enabled }))
vi.mock('@pathfinder/config/logger', () => ({ logger: { warn: mocks.warn } }))
vi.mock('@pathfinder/jobs', () => ({ enqueueAgentRun: mocks.enqueue }))
vi.mock('@pathfinder/db', () => ({
  AgentQuestionActionError: class AgentQuestionActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  answerAgentQuestionAction: mocks.answer,
  withTenantIsolationBypass: async <T>(operation: () => Promise<T>) => operation(),
  db: {},
}))
import { AgentQuestionActionError } from '@pathfinder/db'
import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminAgentQuestionsRouter } from './agent-questions'
const app = router({ admin: adminAgentQuestionsRouter })
const context: TRPCContext = {
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: {
    userId: 'operator_1',
    activeTenantId: 'other_tenant',
    role: null,
    isPlatformAdmin: true,
  },
}
const input = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  questionId: 'question_1',
  expectedUpdatedAt: '2026-09-08T06:00:00.000Z',
  outcome: 'ANSWERED' as const,
  answer: 'These are two different greenhouses. Keep them separate.',
}
const saved = {
  questionId: 'question_1',
  agentRunId: 'run_1',
  status: 'ANSWERED' as const,
  runEligibleToResume: true,
  replayed: false,
}
describe('durable founder answer and worker wake-up', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.enabled.AGENT_RUNNER_ENABLED = true
    mocks.answer.mockResolvedValue(saved)
    mocks.enqueue.mockResolvedValue({ enqueued: true })
  })
  it('reports the saved answer and exact queued branch without implying completion or approval', async () => {
    const result = await app.createCaller(context).admin.answerAgentQuestion(input)
    expect(result).toEqual({ ...saved, executionTriggered: true, dispatchStatus: 'ENQUEUED' })
    expect(mocks.answer).toHaveBeenCalledWith(
      {
        ...input,
        expectedUpdatedAt: new Date(input.expectedUpdatedAt),
        actor: { actorType: 'HUMAN', actorId: 'operator_1', auditRole: 'PLATFORM_ADMIN' },
      },
      {},
    )
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { tenantId: 'tenant_1', runId: 'run_1' },
      { enabled: true, dispatchKey: 'answer-question_1' },
    )
    expect(mocks.answer.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enqueue.mock.invocationCallOrder[0]!,
    )
    expect(result).not.toHaveProperty('approvalGranted')
  })
  it('keeps a committed answer confirmed after ambiguous queue failure and retries the same identity', async () => {
    mocks.enqueue.mockRejectedValueOnce(
      new Error('Synthetic lost acknowledgement; private payload'),
    )
    const caller = app.createCaller(context)
    expect(await caller.admin.answerAgentQuestion(input)).toEqual({
      ...saved,
      executionTriggered: false,
      dispatchStatus: 'UNCONFIRMED',
    })
    mocks.answer.mockResolvedValueOnce({ ...saved, replayed: true })
    expect(await caller.admin.answerAgentQuestion(input)).toEqual({
      ...saved,
      replayed: true,
      executionTriggered: true,
      dispatchStatus: 'ENQUEUED',
    })
    expect(mocks.enqueue.mock.calls[0]).toEqual(mocks.enqueue.mock.calls[1])
    expect(mocks.answer.mock.calls[0]).toEqual(mocks.answer.mock.calls[1])
    expect(mocks.warn).toHaveBeenCalledWith({
      action: 'admin.agent-question.resume-dispatch.unconfirmed',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      questionId: 'question_1',
      agentRunId: 'run_1',
    })
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('greenhouses')
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private payload')
  })
  it('leaves runtime-disabled work eligible without queue I/O', async () => {
    mocks.enabled.AGENT_RUNNER_ENABLED = false
    expect(await app.createCaller(context).admin.answerAgentQuestion(input)).toEqual({
      ...saved,
      executionTriggered: false,
      dispatchStatus: 'DISABLED',
    })
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
  it.each([
    { ...saved, runEligibleToResume: false },
    { ...saved, agentRunId: null },
  ])('does not wake unrelated or ineligible work: %j', async (response) => {
    mocks.answer.mockResolvedValue(response)
    expect(await app.createCaller(context).admin.answerAgentQuestion(input)).toEqual({
      ...response,
      executionTriggered: false,
      dispatchStatus: 'NOT_NEEDED',
    })
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
  it('does not confirm a queue response that did not enqueue', async () => {
    mocks.enqueue.mockResolvedValue({ enqueued: false })
    expect(await app.createCaller(context).admin.answerAgentQuestion(input)).toMatchObject({
      executionTriggered: false,
      dispatchStatus: 'UNCONFIRMED',
    })
  })
  it('preserves canonical conflict and does not dispatch rejected answers', async () => {
    mocks.answer.mockRejectedValue(new AgentQuestionActionError('CONFLICT', 'Question changed'))
    await expect(app.createCaller(context).admin.answerAgentQuestion(input)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
  it('rejects non-admin before persistence or dispatch', async () => {
    const caller = app.createCaller({
      ...context,
      session: { ...context.session!, isPlatformAdmin: false },
    })
    await expect(caller.admin.answerAgentQuestion(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(mocks.answer).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
})
