import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  respond: vi.fn(),
  resume: vi.fn(),
  enqueue: vi.fn(),
  warn: vi.fn(),
  env: { AGENT_RUNNER_ENABLED: true },
}))

vi.mock('@pathfinder/config', () => ({ env: mocks.env }))
vi.mock('@pathfinder/config/logger', () => ({ logger: { warn: mocks.warn } }))
vi.mock('@pathfinder/jobs', () => ({ enqueueAgentRun: mocks.enqueue }))
vi.mock('@pathfinder/db', () => ({
  SupportActionError: class SupportActionError extends Error {},
  OnboardingQuestionActionError: class OnboardingQuestionActionError extends Error {},
  appendSupportMessageAction: vi.fn(),
  canTenantActorAccessSupportRequest: vi.fn(),
  createSupportRequestAction: vi.fn(),
  grantSupportRequestParticipantAction: vi.fn(),
  revokeSupportRequestParticipantAction: vi.fn(),
  respondToSupportInformationAction: mocks.respond,
  resumeOnboardingQuestionFromSupportAction: mocks.resume,
  tenantSupportRequestAccessWhere: vi.fn(() => ({ OR: [] })),
}))

import type { TRPCContext } from '../context'
import { router } from '../core'
import { supportRouter } from './support'

const app = router({ support: supportRouter })
const context: TRPCContext = {
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: {
    userId: 'client_1',
    activeTenantId: 'tenant_1',
    role: 'OWNER',
    isPlatformAdmin: false,
  },
}
const input = {
  operationId: '00000000-0000-4000-8000-000000000001',
  venueId: 'venue_1',
  requestId: 'request_1',
  expectedClientVersion: 1,
  body: 'The accessible entrance is on Oak Street.',
  attachments: [],
}

function savedReply(replayed = false) {
  return {
    status: 'IN_REVIEW',
    missingInformation: [],
    requestVersion: 2,
    clientVersion: 2,
    replayed,
    message: {
      id: 'message_1',
      authorKind: 'CLIENT',
      authorId: 'client_1',
      visibility: 'CLIENT_VISIBLE',
      body: input.body,
      createdAt: new Date('2026-08-18T20:00:00.000Z'),
      attachments: [],
    },
  }
}

function linkedResume(replayed = false) {
  return {
    linked: true,
    replayed,
    runEligibleToResume: true,
    agentRunId: 'run_1',
    questionId: 'question_1',
  }
}

describe('support onboarding question resumption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.env.AGENT_RUNNER_ENABLED = true
    mocks.respond.mockResolvedValue(savedReply())
    mocks.resume.mockResolvedValue(linkedResume())
    mocks.enqueue.mockResolvedValue({ enqueued: true })
  })

  it('claims the exact client message and redispatches only its linked run', async () => {
    const result = await app.createCaller(context).support.respondToInformation(input)

    expect(mocks.resume).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        supportRequestId: 'request_1',
        supportMessageId: 'message_1',
        actor: { actorId: 'client_1', auditRole: 'OWNER' },
      },
      context.db,
    )
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { tenantId: 'tenant_1', runId: 'run_1' },
      { enabled: true, dispatchKey: 'client-answer-question_1' },
    )
    expect(result.onboardingResume).toEqual({
      linked: true,
      replayed: false,
      executionTriggered: true,
      dispatchStatus: 'ENQUEUED',
    })
    expect(JSON.stringify(result.onboardingResume)).not.toMatch(/run_1|question_1/)
  })

  it('returns the saved reply and revision when queue acknowledgement fails', async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error(`queue rejected ${input.body}`))

    const result = await app.createCaller(context).support.respondToInformation(input)

    expect(result).toMatchObject({
      status: 'IN_REVIEW',
      requestVersion: 2,
      clientVersion: 2,
      replayed: false,
      message: { id: 'message_1', body: input.body },
      onboardingResume: {
        linked: true,
        replayed: false,
        executionTriggered: false,
        dispatchStatus: 'UNCONFIRMED',
      },
    })
    expect(mocks.respond).toHaveBeenCalledOnce()
    expect(mocks.resume).toHaveBeenCalledOnce()
    expect(mocks.warn).toHaveBeenCalledWith({
      action: 'support.onboarding-resume.dispatch.unconfirmed',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
    })
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(
      /Oak Street|queue rejected|run_1|question_1/,
    )
    expect(JSON.stringify(result.onboardingResume)).not.toMatch(/run_1|question_1/)
  })

  it('replays the same saved identity with the same deterministic dispatch key', async () => {
    mocks.respond.mockResolvedValueOnce(savedReply(false)).mockResolvedValueOnce(savedReply(true))
    mocks.resume
      .mockResolvedValueOnce(linkedResume(false))
      .mockResolvedValueOnce(linkedResume(true))
    mocks.enqueue
      .mockRejectedValueOnce(new Error('synthetic queue acknowledgement failure'))
      .mockResolvedValueOnce({ enqueued: true })

    const first = await app.createCaller(context).support.respondToInformation(input)
    const replay = await app.createCaller(context).support.respondToInformation(input)

    expect(first.onboardingResume).toEqual({
      linked: true,
      replayed: false,
      executionTriggered: false,
      dispatchStatus: 'UNCONFIRMED',
    })
    expect(replay).toMatchObject({ replayed: true, message: { id: 'message_1' } })
    expect(replay.onboardingResume).toEqual({
      linked: true,
      replayed: true,
      executionTriggered: true,
      dispatchStatus: 'ENQUEUED',
    })
    expect(mocks.respond).toHaveBeenCalledTimes(2)
    expect(mocks.respond.mock.calls[1]).toEqual(mocks.respond.mock.calls[0])
    expect(mocks.resume).toHaveBeenCalledTimes(2)
    expect(mocks.resume.mock.calls[1]).toEqual(mocks.resume.mock.calls[0])
    expect(mocks.enqueue).toHaveBeenNthCalledWith(
      1,
      { tenantId: 'tenant_1', runId: 'run_1' },
      { enabled: true, dispatchKey: 'client-answer-question_1' },
    )
    expect(mocks.enqueue).toHaveBeenNthCalledWith(
      2,
      { tenantId: 'tenant_1', runId: 'run_1' },
      { enabled: true, dispatchKey: 'client-answer-question_1' },
    )
  })

  it('reports disabled and nonlinked branches without enqueueing', async () => {
    mocks.env.AGENT_RUNNER_ENABLED = false
    const disabled = await app.createCaller(context).support.respondToInformation(input)
    expect(disabled.onboardingResume).toMatchObject({
      linked: true,
      executionTriggered: false,
      dispatchStatus: 'DISABLED',
    })
    expect(mocks.enqueue).not.toHaveBeenCalled()

    mocks.env.AGENT_RUNNER_ENABLED = true
    mocks.resume.mockResolvedValue({
      linked: false,
      replayed: false,
      runEligibleToResume: false,
      agentRunId: null,
      questionId: null,
    })
    const nonlinked = await app.createCaller(context).support.respondToInformation({
      ...input,
      operationId: '00000000-0000-4000-8000-000000000002',
    })
    expect(nonlinked.onboardingResume).toEqual({
      linked: false,
      replayed: false,
      executionTriggered: false,
      dispatchStatus: 'NOT_NEEDED',
    })
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it('rejects canonical reply failures and never resumes or dispatches', async () => {
    mocks.respond.mockRejectedValueOnce(new Error('canonical reply persistence failed'))

    await expect(app.createCaller(context).support.respondToInformation(input)).rejects.toThrow(
      'canonical reply persistence failed',
    )

    expect(mocks.resume).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(mocks.warn).not.toHaveBeenCalled()
  })
  it('keeps a late client reply successful while reporting the expired response window', async () => {
    mocks.resume.mockResolvedValue({
      ...linkedResume(),
      runEligibleToResume: false,
      questionExpired: true,
    })
    const result = await app.createCaller(context).support.respondToInformation(input)
    expect(result).toMatchObject({
      message: { id: 'message_1', body: input.body },
      onboardingResume: {
        linked: true,
        questionExpired: true,
        executionTriggered: false,
        dispatchStatus: 'NOT_NEEDED',
      },
    })
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'returns a saved linked response without dispatch when ineligible (replay=%s)',
    async (replayed) => {
      mocks.respond.mockResolvedValue(savedReply(replayed))
      mocks.resume.mockResolvedValue({ ...linkedResume(replayed), runEligibleToResume: false })

      const result = await app.createCaller(context).support.respondToInformation(input)

      expect(result).toMatchObject({
        replayed,
        message: { id: 'message_1', body: input.body },
        onboardingResume: {
          linked: true,
          replayed,
          executionTriggered: false,
          dispatchStatus: 'NOT_NEEDED',
        },
      })
      expect(mocks.enqueue).not.toHaveBeenCalled()
      expect(mocks.warn).not.toHaveBeenCalled()
    },
  )

  it('rejects linked-question resumption failures and never dispatches', async () => {
    mocks.resume.mockRejectedValueOnce(new Error('canonical resume persistence failed'))

    await expect(app.createCaller(context).support.respondToInformation(input)).rejects.toThrow(
      'canonical resume persistence failed',
    )

    expect(mocks.respond).toHaveBeenCalledOnce()
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(mocks.warn).not.toHaveBeenCalled()
  })
})
