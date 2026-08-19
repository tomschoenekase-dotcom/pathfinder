import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  respond: vi.fn(),
  resume: vi.fn(),
  enqueue: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({ env: { AGENT_RUNNER_ENABLED: true } }))
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

describe('support onboarding question resumption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.respond.mockResolvedValue({
      status: 'IN_REVIEW',
      missingInformation: [],
      requestVersion: 2,
      clientVersion: 2,
      replayed: false,
      message: {
        id: 'message_1',
        authorKind: 'CLIENT',
        authorId: 'client_1',
        visibility: 'CLIENT_VISIBLE',
        body: 'The accessible entrance is on Oak Street.',
        createdAt: new Date('2026-08-18T20:00:00.000Z'),
        attachments: [],
      },
    })
    mocks.resume.mockResolvedValue({
      linked: true,
      replayed: false,
      runEligibleToResume: true,
      agentRunId: 'run_1',
      questionId: 'question_1',
    })
    mocks.enqueue.mockResolvedValue({ enqueued: true })
  })

  it('claims the exact client message and redispatches only its linked run', async () => {
    const result = await app.createCaller(context).support.respondToInformation({
      operationId: '00000000-0000-4000-8000-000000000001',
      venueId: 'venue_1',
      requestId: 'request_1',
      expectedClientVersion: 1,
      body: 'The accessible entrance is on Oak Street.',
      attachments: [],
    })

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
    })
    expect(JSON.stringify(result.onboardingResume)).not.toMatch(/run_1|question_1/)
  })
})
