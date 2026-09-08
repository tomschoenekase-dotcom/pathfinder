import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  questionFindFirst: vi.fn(),
  discussionFindMany: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({ env: { AGENT_RUNNER_ENABLED: false } }))
vi.mock('@pathfinder/config/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@pathfinder/jobs', () => ({ enqueueAgentRun: vi.fn() }))
vi.mock('@pathfinder/db', () => {
  class ActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  }
  return {
    AgentQuestionActionError: ActionError,
    AgentQuestionDiscussionActionError: ActionError,
    FounderDecisionPacketActionError: ActionError,
    appendAgentQuestionDiscussionAction: mocks.append,
    withTenantIsolationBypass: async <T>(operation: () => Promise<T>) => operation(),
    db: {
      agentQuestion: { findFirst: mocks.questionFindFirst },
      agentQuestionDiscussionMessage: { findMany: mocks.discussionFindMany },
    },
  }
})

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminAgentQuestionsRouter } from './agent-questions'

const app = router({ questions: adminAgentQuestionsRouter })
const context: TRPCContext = {
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: {
    userId: 'admin-1',
    activeTenantId: null,
    role: null,
    isPlatformAdmin: true,
  },
}

describe('admin agent question discussion', () => {
  beforeEach(() => vi.clearAllMocks())

  it('appends the exact platform-admin payload without answer or execution fields', async () => {
    const message = {
      id: 'discussion-1',
      authorId: 'admin-1',
      body: 'The east greenhouse is in scope.',
      createdAt: new Date('2026-09-08T18:00:00.000Z'),
    }
    mocks.append.mockResolvedValue({ message, replayed: false })
    const input = {
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      questionId: 'question-1',
      body: message.body,
    }
    const result = await app.createCaller(context).questions.appendAgentQuestionDiscussion(input)
    expect(mocks.append).toHaveBeenCalledWith(
      {
        ...input,
        actor: { actorType: 'HUMAN', actorId: 'admin-1', auditRole: 'PLATFORM_ADMIN' },
      },
      expect.any(Object),
    )
    expect(result).toEqual({ message, replayed: false })
    expect(result).not.toHaveProperty('runEligibleToResume')
    expect(result).not.toHaveProperty('approvalGranted')
    expect(result).not.toHaveProperty('executionTriggered')
  })

  it('lists only the exact scoped question with a bounded stable cursor', async () => {
    mocks.questionFindFirst.mockResolvedValue({ id: 'question-1' })
    const first = {
      id: 'discussion-2',
      authorId: 'admin-1',
      body: 'Second',
      createdAt: new Date('2026-09-08T18:00:01.000Z'),
    }
    const second = { ...first, id: 'discussion-1', body: 'First' }
    mocks.discussionFindMany.mockResolvedValue([first, second])
    const result = await app.createCaller(context).questions.listAgentQuestionDiscussion({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      questionId: 'question-1',
      limit: 1,
    })
    expect(mocks.discussionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          questionId: 'question-1',
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    )
    expect(result).toEqual({
      items: [first],
      nextCursor: { createdAt: first.createdAt.toISOString(), id: first.id },
    })
  })

  it('rejects a wrong scoped question without reading discussion rows', async () => {
    mocks.questionFindFirst.mockResolvedValue(null)
    await expect(
      app.createCaller(context).questions.listAgentQuestionDiscussion({
        tenantId: 'tenant-1',
        venueId: 'venue-wrong',
        questionId: 'question-1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.discussionFindMany).not.toHaveBeenCalled()
  })

  it('rejects non-admin callers before persistence', async () => {
    await expect(
      app
        .createCaller({ ...context, session: { ...context.session!, isPlatformAdmin: false } })
        .questions.appendAgentQuestionDiscussion({
          operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          questionId: 'question-1',
          body: 'No access.',
        }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.append).not.toHaveBeenCalled()
  })
})
