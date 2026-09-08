import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), list: vi.fn(), review: vi.fn() }))
vi.mock('@pathfinder/db', () => ({
  getConversationLearningPolicy: mocks.get,
  updateConversationLearningPolicy: mocks.update,
  listConversationLearningCandidates: mocks.list,
  reviewConversationLearningCandidate: mocks.review,
  ConversationLearningActionError: class extends Error {},
}))

import type { TRPCContext } from '../../context'
import { adminConversationLearningRouter } from './conversation-learning'

const scope = { tenantId: 'tenant-a', venueId: 'venue-a' }
const review = {
  ...scope,
  operationId: '10000000-0000-4000-8000-000000000001',
  insightId: '10000000-0000-4000-8000-000000000002',
  expectedRevision: 3,
  action: 'ACCEPT_FOR_PROPOSAL' as const,
  reviewerFeedback: 'Checked the exact source; prepare a proposal for review.',
}
function caller(admin: boolean) {
  return adminConversationLearningRouter.createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'reviewer',
      activeTenantId: 'tenant-a',
      role: 'OWNER',
      isPlatformAdmin: admin,
    },
  })
}

describe('conversation learning admin authority', () => {
  beforeEach(() => vi.clearAllMocks())

  it('denies a tenant owner from the platform review endpoints', async () => {
    await expect(caller(false).listConversationLearningCandidates(scope)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(caller(false).reviewConversationLearningCandidate(review)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it('derives reviewer identity and preserves exact revision and feedback', async () => {
    mocks.review.mockResolvedValue({ canonicalKnowledgeChanged: false })
    await expect(caller(true).reviewConversationLearningCandidate(review)).resolves.toMatchObject({
      canonicalKnowledgeChanged: false,
    })
    expect(mocks.review).toHaveBeenCalledWith({
      ...review,
      actor: { type: 'PLATFORM_ADMIN', id: 'reviewer' },
    })
  })

  it('rejects an injected actor or missing feedback before mutation', async () => {
    await expect(
      caller(true).reviewConversationLearningCandidate({
        ...review,
        actor: { id: 'other' },
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller(true).reviewConversationLearningCandidate({ ...review, reviewerFeedback: '' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.review).not.toHaveBeenCalled()
  })
})
