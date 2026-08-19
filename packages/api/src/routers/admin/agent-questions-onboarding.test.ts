import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  create: vi.fn(),
  venueFindFirst: vi.fn(),
  membershipFindMany: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({ env: { AGENT_RUNNER_ENABLED: false } }))
vi.mock('@pathfinder/jobs', () => ({ enqueueAgentRun: vi.fn() }))
vi.mock('@pathfinder/db', () => ({
  AgentQuestionActionError: class AgentQuestionActionError extends Error {},
  OnboardingQuestionActionError: class OnboardingQuestionActionError extends Error {},
  answerAgentQuestionAction: vi.fn(),
  createClientOnboardingQuestionAction: mocks.create,
  withTenantIsolationBypass: mocks.bypass,
  db: {
    agentQuestion: { findMany: vi.fn() },
    venue: { findFirst: mocks.venueFindFirst },
    tenantMembership: { findMany: mocks.membershipFindMany },
  },
}))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminAgentQuestionsRouter } from './agent-questions'

const app = router({ admin: adminAgentQuestionsRouter })
const context: TRPCContext = {
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: {
    userId: 'operator_1',
    activeTenantId: 'tenant_other',
    role: null,
    isPlatformAdmin: true,
  },
}

describe('admin onboarding question routing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes exact scope, recipient, CAS revision, and a session-derived admin actor', async () => {
    mocks.create.mockResolvedValue({
      link: { id: 'link_1', supportRequestId: 'request_1' },
      replayed: false,
      approvalGranted: false,
    })
    const expectedUpdatedAt = '2026-08-18T20:00:00.000Z'
    const result = await app.createCaller(context).admin.routeAgentQuestionToClient({
      operationId: '00000000-0000-4000-8000-000000000001',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      questionId: 'question_1',
      expectedUpdatedAt,
      recipientUserId: 'client_1',
      category: 'ACCESSIBILITY',
      subject: 'Confirm the accessible entrance',
      why: 'The sources disagree.',
      whatWasFound: 'Two different entrances are named.',
      effect: 'The answer unblocks accessibility review.',
    })

    expect(mocks.create).toHaveBeenCalledWith(
      {
        operationId: '00000000-0000-4000-8000-000000000001',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentQuestionId: 'question_1',
        expectedQuestionUpdatedAt: new Date(expectedUpdatedAt),
        recipientUserId: 'client_1',
        category: 'ACCESSIBILITY',
        subject: 'Confirm the accessible entrance',
        why: 'The sources disagree.',
        whatWasFound: 'Two different entrances are named.',
        effect: 'The answer unblocks accessibility review.',
        actor: { actorId: 'operator_1', auditRole: 'PLATFORM_ADMIN' },
      },
      expect.anything(),
    )
    expect(result.approvalGranted).toBe(false)
  })

  it('returns only active recipients after proving the exact venue belongs to the tenant', async () => {
    mocks.venueFindFirst.mockResolvedValue({ id: 'venue_1' })
    mocks.membershipFindMany.mockResolvedValue([
      {
        userId: 'client_1',
        role: 'OWNER',
        user: { fullName: 'Venue Owner', email: 'owner@example.test' },
      },
    ])
    const result = await app
      .createCaller(context)
      .admin.listOnboardingQuestionRecipients({ tenantId: 'tenant_1', venueId: 'venue_1' })
    expect(mocks.venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { id: true },
    })
    expect(mocks.membershipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant_1', status: 'ACTIVE' } }),
    )
    expect(result).toHaveLength(1)
  })
})
